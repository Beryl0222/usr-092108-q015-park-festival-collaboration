import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { availableForChannel, describeOrderForCustomer, traceOrder } from "../src/fulfillment.js";
import { applyEvent, createState } from "../src/ledger.js";
import { validateEvent } from "../src/validator.js";

test("中秋联名联调事件流可完整回放", async () => {
  const events = JSON.parse(await readFile(new URL("../data/scenario.mid-autumn.json", import.meta.url), "utf8"));
  const state = createState();
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 信封非法`);
    applyEvent(state, event);
  }

  // 履约与追溯：自提订单追到具体食品批次与文创部件
  const trace = traceOrder(state, "order-001");
  assert.equal(trace.status, "fulfilled");
  assert.equal(trace.bundle_batch, "bb-01");
  assert.deepEqual(trace.food_batches, ["fb-lotus-01", "fb-wuren-01"]);
  assert.deepEqual(trace.component_lots, ["lot-sachet-01", "lot-tea-01", "lot-card-01"]);

  // 取消的订单安全释放了配额：线上可售回到全额
  assert.equal(state.orders.get("order-002").status, "cancelled");
  assert.equal(availableForChannel(state, "online", "spec-standard"), 80);
  // 文创店：配额 120，已履约 3 盒，可售 = min(120, 200 - 3) = 117
  assert.equal(availableForChannel(state, "store-wenchuang", "spec-standard"), 117);

  // 结算只计实际履约：3 盒
  assert.equal(state.settlements.get("settle-2026-09-wenchuang").fulfilled_qty, 3);
  assert.equal(state.orders.get("order-001").settled, true);

  // 消费者视角：取货时间、口味与过敏原
  const view = describeOrderForCustomer(state, "order-001");
  assert.equal(view.pickup.slot, "2026-09-25T10:00:00+08:00");
  assert.deepEqual(view.flavors, ["莲蓉", "五仁"]);
  assert.deepEqual(view.allergens, ["蛋黄", "坚果", "芝麻"]);

  // 装配消耗了批次余量，剩余可追溯
  assert.equal(state.foodBatches.get("fb-lotus-01").remaining, 300);
  assert.equal(state.componentLots.get("lot-sachet-01").remaining, 200);
});
