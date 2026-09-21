import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES, validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("校验器词表与契约保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...AGGREGATE_TYPES].sort(), [...schema.properties.aggregate_type.enum].sort());
});

test("非法信封被逐条指出", () => {
  assert.equal(validateEvent({}).length, 7);
  const bad = {
    event_id: "x",
    event_type: "NOT_A_TYPE",
    aggregate_type: "not_an_aggregate",
    aggregate_id: "a",
    occurred_at: "不是时间",
    version: 0,
    summary: "",
    payload: [],
  };
  const errors = validateEvent(bad);
  assert.ok(errors.some((e) => e.includes("未知事件类型")));
  assert.ok(errors.some((e) => e.includes("未知聚合类型")));
  assert.ok(errors.some((e) => e.includes("version")));
  assert.ok(errors.some((e) => e.includes("occurred_at")));
  assert.ok(errors.some((e) => e.includes("summary")));
  assert.ok(errors.some((e) => e.includes("payload")));
});
