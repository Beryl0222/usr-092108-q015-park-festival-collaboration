import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptComponent,
  allocateQuota,
  assembleBundle,
  availableForChannel,
  cancelOrder,
  clearDesign,
  completeRemedy,
  defineBundleSpec,
  defineCapacity,
  describeOrderForCustomer,
  disposeNearExpiry,
  expireReservation,
  fulfillOrder,
  grantLicense,
  locateFlavorImpact,
  narrowLicense,
  produceFoodBatch,
  publishLabel,
  quarantineFlavor,
  registerRecipe,
  releaseBundle,
  reserveOrder,
  settleChannel,
  shipRemedy,
  traceOrder,
} from "../src/fulfillment.js";
import { applyEvent, createState } from "../src/ledger.js";
import { validateEvent } from "../src/validator.js";

const T0 = "2026-09-01T09:00:00+08:00";
const T1 = "2026-09-10T09:00:00+08:00";
const T2 = "2026-09-15T09:00:00+08:00";
const T3 = "2026-09-20T09:00:00+08:00";

// 命令按传入顺序逐个求值并折叠，保证同一聚合的 version 递增；
// 每个产出的事件都要先过信封校验。
function run(state, ...commands) {
  const events = [];
  for (const command of commands) {
    const result = typeof command === "function" ? command() : command;
    for (const event of [result].flat()) {
      if (!event) continue;
      assert.deepEqual(validateEvent(event), []);
      applyEvent(state, event);
      events.push(event);
    }
  }
  return events;
}

// 基础环境：双产能、授权 v1/v2、设计、莲蓉/五仁配方、标准礼盒规格与标签 L1。
function boot() {
  const state = createState();
  run(
    state,
    () => defineCapacity(state, { kind: "handmade_900g", total: 100, at: T0 }),
    () => defineCapacity(state, { kind: "standard", total: 1000, at: T0 }),
    () => grantLicense(state, { license_id: "lic-1", elements: ["古建纹样"], design_versions: ["v1", "v2"], valid_from: T0, at: T0 }),
    () => clearDesign(state, { design_id: "design-1", version: "v1", license_id: "lic-1", elements: ["古建纹样"], at: T0 }),
    () => clearDesign(state, { design_id: "design-1", version: "v2", license_id: "lic-1", elements: ["古建纹样"], at: T0 }),
    () => registerRecipe(state, { flavor: "莲蓉", allergens: ["蛋黄"], at: T0 }),
    () => registerRecipe(state, { flavor: "五仁", allergens: ["坚果", "芝麻"], at: T0 }),
    () =>
      defineBundleSpec(state, {
        spec_id: "spec-a",
        kind: "standard",
        components: [
          { component_type: "sachet", qty_per: 1 },
          { component_type: "tea", qty_per: 1 },
          { component_type: "card", qty_per: 1 },
        ],
        flavors: [
          { flavor: "莲蓉", qty_per: 1 },
          { flavor: "五仁", qty_per: 1 },
        ],
        at: T0,
      }),
    () => publishLabel(state, { spec_id: "spec-a", label_version: "L1", at: T0 }),
  );
  return state;
}

// 在基础环境上生产食品、验收部件并装配放行 qty 盒，返回批次与部件 id。
function bootReleased(state, qty = 10) {
  run(
    state,
    () => produceFoodBatch(state, { batch_id: "fb-lotus-01", flavor: "莲蓉", kind: "standard", qty: 500, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v1", at: T1 }),
    () => produceFoodBatch(state, { batch_id: "fb-wuren-01", flavor: "五仁", kind: "standard", qty: 500, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v1", at: T1 }),
    () => acceptComponent(state, { lot_id: "lot-sachet-01", component_type: "sachet", qty: 500, design_id: "design-1", design_version: "v1", at: T1 }),
    () => acceptComponent(state, { lot_id: "lot-tea-01", component_type: "tea", qty: 500, at: T1 }),
    () => acceptComponent(state, { lot_id: "lot-card-01", component_type: "card", qty: 500, design_id: "design-1", design_version: "v2", at: T1 }),
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-01",
        spec_id: "spec-a",
        qty,
        food_batches: ["fb-lotus-01", "fb-wuren-01"],
        component_lots: ["lot-sachet-01", "lot-tea-01", "lot-card-01"],
        at: T1,
      }),
    () => releaseBundle(state, { bundle_batch_id: "bb-01", at: T1 }),
  );
  return "bb-01";
}

test("礼盒放行要求全部部件与当前标签齐备", () => {
  const state = boot();
  run(
    state,
    () => produceFoodBatch(state, { batch_id: "fb-lotus-01", flavor: "莲蓉", kind: "standard", qty: 100, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v1", at: T1 }),
    () => produceFoodBatch(state, { batch_id: "fb-wuren-01", flavor: "五仁", kind: "standard", qty: 100, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v1", at: T1 }),
    () => acceptComponent(state, { lot_id: "lot-sachet-01", component_type: "sachet", qty: 100, at: T1 }),
    () => acceptComponent(state, { lot_id: "lot-tea-01", component_type: "tea", qty: 100, at: T1 }),
  );
  // 缺祝福卡，部件不齐不可装配
  assert.throws(
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-01",
        spec_id: "spec-a",
        qty: 100,
        food_batches: ["fb-lotus-01", "fb-wuren-01"],
        component_lots: ["lot-sachet-01", "lot-tea-01"],
        at: T1,
      }),
    /部件数量不足：card 缺 100/,
  );
  run(
    state,
    () => acceptComponent(state, { lot_id: "lot-card-01", component_type: "card", qty: 100, at: T1 }),
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-01",
        spec_id: "spec-a",
        qty: 100,
        food_batches: ["fb-lotus-01", "fb-wuren-01"],
        component_lots: ["lot-sachet-01", "lot-tea-01", "lot-card-01"],
        at: T1,
      }),
  );
  // 换批后标签不是当前版次，不可放行
  run(state, () => publishLabel(state, { spec_id: "spec-a", label_version: "L2", at: T2 }));
  assert.throws(() => releaseBundle(state, { bundle_batch_id: "bb-01", at: T2 }), /标签版次 L1 不是当前版次 L2/);
  // 换回当前标签后放行成功
  run(
    state,
    () => publishLabel(state, { spec_id: "spec-a", label_version: "L1", at: T2 }),
    () => releaseBundle(state, { bundle_batch_id: "bb-01", at: T2 }),
  );
  assert.equal(state.bundleBatches.get("bb-01").status, "released");
});

test("900克手工与标准礼盒产能各自独立", () => {
  const state = boot();
  run(
    state,
    () => produceFoodBatch(state, { batch_id: "fb-hand-01", flavor: "莲蓉", kind: "handmade_900g", qty: 100, expires_at: "2026-10-20T00:00:00+08:00", at: T1 }),
  );
  // 手工产能已占满，标准产能不受影响
  assert.throws(
    () => produceFoodBatch(state, { batch_id: "fb-hand-02", flavor: "莲蓉", kind: "handmade_900g", qty: 1, expires_at: "2026-10-20T00:00:00+08:00", at: T1 }),
    /handmade_900g 产能不足，剩余 0/,
  );
  run(state, () =>
    produceFoodBatch(state, { batch_id: "fb-std-01", flavor: "五仁", kind: "standard", qty: 500, expires_at: "2026-10-20T00:00:00+08:00", at: T1 }),
  );
  // 手工批次不能装进标准礼盒
  assert.throws(
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-x",
        spec_id: "spec-a",
        qty: 1,
        food_batches: ["fb-hand-01", "fb-std-01"],
        component_lots: [],
        at: T1,
      }),
    /产能类型 handmade_900g 与规格 standard 不符/,
  );
});

test("门店只看到本渠道真实可售而非全网虚数", () => {
  const state = boot();
  bootReleased(state, 10);
  run(state, () => allocateQuota(state, { channel: "store-a", spec_id: "spec-a", qty: 4, at: T2 }));
  // 全网已放行 10 盒，但门店只有 4 盒配额；未分配配额的渠道可售为 0
  assert.equal(availableForChannel(state, "store-a", "spec-a"), 4);
  assert.equal(availableForChannel(state, "online", "spec-a"), 0);
  run(state, () => reserveOrder(state, { order_id: "o-1", channel: "store-a", spec_id: "spec-a", qty: 4, at: T2 }));
  assert.equal(availableForChannel(state, "store-a", "spec-a"), 0);
  assert.throws(() => reserveOrder(state, { order_id: "o-2", channel: "store-a", spec_id: "spec-a", qty: 1, at: T2 }), /可售不足/);
  assert.throws(() => reserveOrder(state, { order_id: "o-3", channel: "online", spec_id: "spec-a", qty: 1, at: T2 }), /可售不足/);
});

test("迟到支付与取消订单安全释放配额，可重试不重复释放", () => {
  const state = boot();
  bootReleased(state, 5);
  run(
    state,
    () => allocateQuota(state, { channel: "store-a", spec_id: "spec-a", qty: 5, at: T2 }),
    () => reserveOrder(state, { order_id: "o-1", channel: "store-a", spec_id: "spec-a", qty: 3, at: T2 }),
  );
  assert.equal(availableForChannel(state, "store-a", "spec-a"), 2);
  // 迟到支付按到期处理，释放配额；重复到期、再取消都是安全空操作
  run(state, () => expireReservation(state, { order_id: "o-1", at: T3 }));
  assert.equal(availableForChannel(state, "store-a", "spec-a"), 5);
  assert.equal(expireReservation(state, { order_id: "o-1", at: T3 }), null);
  assert.equal(cancelOrder(state, { order_id: "o-1", at: T3 }), null);
  assert.equal(availableForChannel(state, "store-a", "spec-a"), 5);
  // 取消同样只释放一次
  run(
    state,
    () => reserveOrder(state, { order_id: "o-2", channel: "store-a", spec_id: "spec-a", qty: 5, at: T3 }),
    () => cancelOrder(state, { order_id: "o-2", at: T3 }),
  );
  assert.equal(cancelOrder(state, { order_id: "o-2", at: T3 }), null);
  assert.equal(availableForChannel(state, "store-a", "spec-a"), 5);
  assert.equal(state.quotas.get("store-a::spec-a").reserved, 0);
});

test("口味检验异常只定位相关组合与订单，不冻结无关部件", () => {
  const state = boot();
  bootReleased(state, 10);
  // 只含五仁的另一规格与组合，不应被莲蓉异常波及
  run(
    state,
    () =>
      defineBundleSpec(state, {
        spec_id: "spec-b",
        kind: "standard",
        components: [{ component_type: "tea", qty_per: 1 }],
        flavors: [{ flavor: "五仁", qty_per: 1 }],
        at: T1,
      }),
    () => publishLabel(state, { spec_id: "spec-b", label_version: "L1", at: T1 }),
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-02",
        spec_id: "spec-b",
        qty: 5,
        food_batches: ["fb-wuren-01"],
        component_lots: ["lot-tea-01"],
        at: T1,
      }),
    () => allocateQuota(state, { channel: "store-a", spec_id: "spec-a", qty: 10, at: T2 }),
    () => reserveOrder(state, { order_id: "o-1", channel: "store-a", spec_id: "spec-a", qty: 2, at: T2 }),
  );
  const events = quarantineFlavor(state, { flavor: "莲蓉", reason: "检验异常", at: T3 });
  run(state, ...events);
  // 莲蓉批次被隔离，五仁批次不受影响
  assert.equal(state.foodBatches.get("fb-lotus-01").status, "quarantined");
  assert.equal(state.foodBatches.get("fb-wuren-01").status, "ok");
  // 含莲蓉的在库组合被冻结，纯五仁组合不受影响
  assert.equal(state.bundleBatches.get("bb-01").status, "released"); // 已放行流入市场，不原地冻结
  assert.equal(state.bundleBatches.get("bb-02").status, "assembled");
  // 香囊、茶饮、祝福卡等部件一律不动
  for (const lot of state.componentLots.values()) assert.equal(lot.status, "ok");
  // 定位：相关批次、组合与订单都在清单里
  const impact = locateFlavorImpact(state, "莲蓉");
  assert.deepEqual(impact.food_batches, ["fb-lotus-01"]);
  assert.deepEqual(impact.bundle_batches, ["bb-01"]);
  assert.deepEqual(impact.orders, ["o-1"]);
});

test("授权收窄只约束尚未生产的版次，已产批次保留当时依据", () => {
  const state = boot();
  // 收窄前已用 v2 生产食品批次、验收祝福卡
  run(
    state,
    () => produceFoodBatch(state, { batch_id: "fb-lotus-old", flavor: "莲蓉", kind: "standard", qty: 100, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v2", at: T1 }),
    () => acceptComponent(state, { lot_id: "lot-card-old", component_type: "card", qty: 100, design_id: "design-1", design_version: "v2", at: T1 }),
    () => narrowLicense(state, { license_id: "lic-1", removed_versions: ["v2"], effective_at: T2, at: T2 }),
  );
  // 收窄后 v2 不能再生产，v1 不受影响
  assert.throws(
    () => produceFoodBatch(state, { batch_id: "fb-new", flavor: "莲蓉", kind: "standard", qty: 1, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v2", at: T3 }),
    /授权.*不覆盖版次 v2/,
  );
  assert.throws(() => acceptComponent(state, { lot_id: "lot-card-new", component_type: "card", qty: 1, design_id: "design-1", design_version: "v2", at: T3 }), /授权.*不覆盖版次 v2/);
  run(
    state,
    () => produceFoodBatch(state, { batch_id: "fb-wuren-01", flavor: "五仁", kind: "standard", qty: 100, expires_at: "2026-10-20T00:00:00+08:00", design_id: "design-1", design_version: "v1", at: T3 }),
    () => acceptComponent(state, { lot_id: "lot-sachet-01", component_type: "sachet", qty: 100, design_id: "design-1", design_version: "v1", at: T3 }),
    () => acceptComponent(state, { lot_id: "lot-tea-01", component_type: "tea", qty: 100, at: T3 }),
  );
  // 收窄前已产的 v2 批次仍可装配放行，当时依据保留在事件里
  run(
    state,
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-old",
        spec_id: "spec-a",
        qty: 100,
        food_batches: ["fb-lotus-old", "fb-wuren-01"],
        component_lots: ["lot-sachet-01", "lot-tea-01", "lot-card-old"],
        at: T3,
      }),
    () => releaseBundle(state, { bundle_batch_id: "bb-old", at: T3 }),
  );
  assert.equal(state.bundleBatches.get("bb-old").status, "released");
});

test("合作方按实际履约清算，取消与过期不计", () => {
  const state = boot();
  bootReleased(state, 10);
  run(
    state,
    () => allocateQuota(state, { channel: "store-a", spec_id: "spec-a", qty: 10, at: T2 }),
    () => reserveOrder(state, { order_id: "o-1", channel: "store-a", spec_id: "spec-a", qty: 2, at: T2 }),
    () => reserveOrder(state, { order_id: "o-2", channel: "store-a", spec_id: "spec-a", qty: 3, at: T2 }),
    () => cancelOrder(state, { order_id: "o-2", at: T2 }),
    () => fulfillOrder(state, { order_id: "o-1", method: "pickup", at: T3 }),
  );
  const [settlement] = run(state, () => settleChannel(state, { settlement_id: "settle-1", channel: "store-a", period: "2026-09", at: T3 }));
  assert.deepEqual(settlement.payload.order_ids, ["o-1"]);
  assert.equal(settlement.payload.fulfilled_qty, 2);
  assert.throws(() => settleChannel(state, { settlement_id: "settle-2", channel: "store-a", period: "2026-09", at: T3 }), /无待结算履约单/);
});

test("任一订单可追到食品批次与文创部件，补寄沿用同一追溯", () => {
  const state = boot();
  bootReleased(state, 10);
  run(
    state,
    () => allocateQuota(state, { channel: "store-a", spec_id: "spec-a", qty: 10, at: T2 }),
    () => reserveOrder(state, { order_id: "o-1", channel: "store-a", spec_id: "spec-a", qty: 1, at: T2 }),
    () => fulfillOrder(state, { order_id: "o-1", method: "express", at: T3 }),
  );
  const trace = traceOrder(state, "o-1");
  assert.deepEqual(trace.food_batches, ["fb-lotus-01", "fb-wuren-01"]);
  assert.deepEqual(trace.component_lots, ["lot-sachet-01", "lot-tea-01", "lot-card-01"]);
  assert.equal(trace.bundle_batch, "bb-01");
  const [remedy] = run(state, () => shipRemedy(state, { order_id: "o-1", at: T3 }));
  assert.deepEqual(remedy.payload.food_batches, trace.food_batches);
  assert.deepEqual(remedy.payload.component_lots, trace.component_lots);
  assert.throws(() => shipRemedy(state, { order_id: "o-1", at: T3 }), /已有进行中的补寄/);
  run(state, () => completeRemedy(state, { order_id: "o-1", at: T3 }));
  assert.equal(state.orders.get("o-1").remedy.completed, true);
});

test("临期处置只影响到期窗口内的批次", () => {
  const state = boot();
  run(
    state,
    () => produceFoodBatch(state, { batch_id: "fb-soon", flavor: "莲蓉", kind: "standard", qty: 50, expires_at: "2026-09-25T00:00:00+08:00", at: T1 }),
    () => produceFoodBatch(state, { batch_id: "fb-far", flavor: "五仁", kind: "standard", qty: 50, expires_at: "2026-12-01T00:00:00+08:00", at: T1 }),
  );
  const events = disposeNearExpiry(state, { now: "2026-09-21T00:00:00+08:00", within_days: 7 });
  assert.deepEqual(events.map((e) => e.aggregate_id), ["fb-soon"]);
  run(state, ...events);
  assert.equal(state.foodBatches.get("fb-soon").status, "disposed");
  assert.equal(state.foodBatches.get("fb-far").status, "ok");
  assert.throws(
    () =>
      assembleBundle(state, {
        bundle_batch_id: "bb-x",
        spec_id: "spec-a",
        qty: 1,
        food_batches: ["fb-soon", "fb-far"],
        component_lots: [],
        at: T3,
      }),
    /状态为 disposed，不可装配/,
  );
});

test("消费者可确认取货时间、口味与过敏原", () => {
  const state = boot();
  bootReleased(state, 10);
  run(
    state,
    () => allocateQuota(state, { channel: "store-a", spec_id: "spec-a", qty: 10, at: T2 }),
    () =>
      reserveOrder(state, {
        order_id: "o-1",
        channel: "store-a",
        spec_id: "spec-a",
        qty: 1,
        pickup: { store: "文创店A", slot: "2026-09-25T10:00:00+08:00" },
        at: T2,
      }),
  );
  const view = describeOrderForCustomer(state, "o-1");
  assert.equal(view.pickup.slot, "2026-09-25T10:00:00+08:00");
  assert.deepEqual(view.flavors, ["莲蓉", "五仁"]);
  assert.deepEqual(view.allergens, ["蛋黄", "坚果", "芝麻"]);
});
