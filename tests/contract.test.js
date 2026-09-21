import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { EVENT_AGGREGATE, EVENT_TYPES, AGGREGATE_TYPES } from "../src/eventCatalog.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("事件类型与聚合类型一一对应，且与 JSON Schema 枚举一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...AGGREGATE_TYPES].sort(), [...schema.properties.aggregate_type.enum].sort());
  for (const type of EVENT_TYPES) {
    const event = {
      event_id: "e1", event_type: type, aggregate_type: EVENT_AGGREGATE[type],
      aggregate_id: "a1", occurred_at: "2026-09-21T10:00:00+08:00", version: 1, summary: "x"
    };
    assert.deepEqual(validateEvent(event), []);
  }
});

test("事件类型与聚合不匹配、时间格式错误、version 非法时被拒", () => {
  const bad = {
    event_id: "e1", event_type: "ORDER_RESERVED", aggregate_type: "bundle_batch",
    aggregate_id: "a1", occurred_at: "2026/09/21", version: 0, summary: "x"
  };
  const errors = validateEvent(bad);
  assert.ok(errors.some((m) => m.includes("应属于聚合")));
  assert.ok(errors.some((m) => m.includes("ISO 8601")));
  assert.ok(errors.some((m) => m.includes("正整数")));
});
