import { Codes, fail } from "../domain/errors.js";
import { EVENT_AGGREGATE } from "../eventCatalog.js";

// 单进程内存事件存储：一次 commit 跨多个流原子写入，
// 用 expectedVersion 做乐观并发控制。提交时把事件流过对应 reducer 演算，
// reducer 抛出即整笔事务回滚——业务不变量只有一处权威实现。
// 生产环境可替换为支持多流事务（或同一分区键）的事件存储实现。
export class EventStore {
  #streams = new Map();
  #reducers;
  #initial;

  constructor({ reducers = {}, initial = {} } = {}) {
    this.#reducers = reducers;
    this.#initial = initial;
  }

  // 应用层把聚合 reducer 注入存储；外部直接 new 的裸存储也能被补装。
  configure(reducers, initial = {}) {
    this.#reducers = { ...this.#reducers, ...reducers };
    this.#initial = { ...this.#initial, ...initial };
  }

  commit(entries, clock) {
    const snapshot = new Map();
    for (const [k, v] of this.#streams) snapshot.set(k, { ...v, events: [...v.events] });

    const prepared = [];
    // 先在“下一状态”上完整演算全部事件，任何一步失败都不写入。
    const nextStates = new Map();
    for (const entry of entries) {
      const stream = this.#streams.get(entry.stream);
      const currentVersion = stream ? stream.version : 0;
      if (entry.expectedVersion !== currentVersion) {
        fail(Codes.CONCURRENT_WRITE, `流 ${entry.stream} 版本冲突：期望 ${entry.expectedVersion}，实际 ${currentVersion}`);
      }
      let version = currentVersion;
      let state = nextStates.get(entry.stream) ?? stream?.state ?? undefined;
      for (const draft of entry.events) {
        version += 1;
        const event = {
          event_id: draft.event_id,
          event_type: draft.event_type,
          aggregate_type: EVENT_AGGREGATE[draft.event_type],
          aggregate_id: draft.aggregate_id,
          occurred_at: draft.occurred_at || clock(),
          version,
          summary: draft.summary,
          data: draft.data ?? {}
        };
        if (!EVENT_AGGREGATE[event.event_type]) fail(Codes.UNKNOWN_EVENT, `未知事件类型：${event.event_type}`);
        if (event.aggregate_type !== EVENT_AGGREGATE[event.event_type]) {
          fail(Codes.UNKNOWN_EVENT, `事件 ${event.event_type} 与聚合 ${event.aggregate_type} 不匹配`);
        }
        if (state === undefined) state = this.#initial[event.aggregate_type] ? this.#initial[event.aggregate_type]() : null;
        const reducer = this.#reducers[event.aggregate_type];
        if (reducer) state = reducer(state, event);
        prepared.push({ stream: entry.stream, event });
      }
      nextStates.set(entry.stream, state);
    }

    try {
      for (const { stream, event } of prepared) {
        const rec = this.#streams.get(stream);
        if (!rec) this.#streams.set(stream, { version: 1, events: [event] });
        else {
          rec.version += 1;
          rec.events.push(event);
        }
      }
      // 演算成功后统一挂最终状态（每流一次）。
      for (const [stream, state] of nextStates) {
        const rec = this.#streams.get(stream);
        if (rec) rec.state = state;
      }
    } catch (err) {
      this.#streams = snapshot;
      throw err;
    }
    return prepared.map((p) => p.event);
  }

  loadStream(stream) {
    return this.#streams.has(stream) ? [...this.#streams.get(stream).events] : [];
  }

  allEvents() {
    const out = [];
    for (const rec of this.#streams.values()) out.push(...rec.events);
    return out;
  }
}
