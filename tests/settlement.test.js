import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld } from "./helpers/fixture.js";

const sellStart = "2026-09-11T10:00:00+08:00";
const deadline = "2026-09-12T22:00:00+08:00";
const period = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-30T23:59:59+08:00" };

function placeFulfilled(app, { orderId, quotaId, batchId, storeId, type, price, shares, at }) {
  const expires = new Date(Date.parse(at) + 86400000).toISOString();
  app.reserveOrder({ order_id: orderId, quota_id: quotaId, units: 1, fulfillment_type: type, unit_price: price, expires_at: expires, partner_shares: shares, at });
  app.confirmSelections({
    order_id: orderId, pickup_time: at,
    flavor_selections: [{ flavor_id: "flv-lotus" }, { flavor_id: "flv-mixnut" }],
    allergens_acknowledged: ["wheat", "egg", "nuts"], at
  });
  app.payOrder({ order_id: orderId, at });
  if (type === "pickup") {
    app.completePickup({ order_id: orderId, store_id: storeId, bundle_batch_id: batchId, at });
  } else {
    app.dispatchShipment({ order_id: orderId, shipment_id: `sh-${orderId}`, bundle_batch_id: batchId, carrier: "SF", at });
    app.deliverShipment({ order_id: orderId, shipment_id: `sh-${orderId}`, at });
  }
}

test("合作方按实际履约清算：已履约计入、未支付/已取消排除、不可重复清算", () => {
  const { app, repo, ids } = buildWorld();

  // 门店履约 2 单（公园分成 20/单）
  placeFulfilled(app, { orderId: "ord-set-1", quotaId: ids.quotaStore1, batchId: ids.batchA, storeId: "S1", type: "pickup", price: 268, shares: { "P-park": 20, "P-filigree": 15 }, at: "2026-09-13T15:00:00+08:00" });
  placeFulfilled(app, { orderId: "ord-set-2", quotaId: ids.quotaStore1, batchId: ids.batchB, storeId: "S1", type: "pickup", price: 268, shares: { "P-park": 20, "P-filigree": 15 }, at: "2026-09-14T11:00:00+08:00" });

  // 一笔已支付但尚未履约（已发货未签收）：不应计入
  app.reserveOrder({ order_id: "ord-set-3", quota_id: ids.quotaOnline, units: 1, fulfillment_type: "express", unit_price: 268, expires_at: deadline, partner_shares: { "P-park": 20 }, at: sellStart });
  app.payOrder({ order_id: "ord-set-3", at: sellStart });
  app.dispatchShipment({ order_id: "ord-set-3", shipment_id: "sh-set-3", bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-09-20T09:00:00+08:00" });

  // 一笔取消订单：不应计入
  app.reserveOrder({ order_id: "ord-set-4", quota_id: ids.quotaOnline, units: 1, fulfillment_type: "express", unit_price: 268, expires_at: deadline, partner_shares: { "P-park": 20 }, at: sellStart });
  app.cancelOrder({ order_id: "ord-set-4", reason: "customer_cancelled", at: "2026-09-11T18:00:00+08:00" });

  const park = app.settlePartner({ partner_id: "P-park", period, at: "2026-10-01T10:00:00+08:00" });
  assert.deepEqual(park.lines.map((l) => l.order_id).sort(), ["ord-set-1", "ord-set-2"]);
  assert.equal(park.amount, 40);

  // 花丝合作方同样按其份额清算
  const filigree = app.settlePartner({ partner_id: "P-filigree", period, at: "2026-10-01T10:00:00+08:00" });
  assert.deepEqual(filigree.lines.map((l) => l.order_id).sort(), ["ord-set-1", "ord-set-2"]);
  assert.equal(filigree.amount, 30);

  // 重复清算同一期：没有新增已履约订单时无可清算项
  assert.throws(
    () => app.settlePartner({ partner_id: "P-park", period, settlement_id: park.settlementId, at: "2026-10-01T11:00:00+08:00" }),
    (err) => err.code === "NOTHING_TO_SETTLE"
  );

  // 第三单签收后再次清算，只补新增订单，不重复前两单
  app.deliverShipment({ order_id: "ord-set-3", shipment_id: "sh-set-3", at: "2026-09-21T10:00:00+08:00" });
  const park2 = app.settlePartner({ partner_id: "P-park", period, settlement_id: park.settlementId, at: "2026-09-22T10:00:00+08:00" });
  assert.deepEqual(park2.lines.map((l) => l.order_id), ["ord-set-3"]);
  assert.equal(park2.amount, 20);
});

test("补寄签收时间决定履约完成时点：破损未补完不计入清算", () => {
  const { app, ids } = buildWorld();
  app.reserveOrder({ order_id: "ord-dmg", quota_id: ids.quotaStore1, units: 1, fulfillment_type: "express", unit_price: 268, expires_at: deadline, partner_shares: { "P-filigree": 15 }, at: sellStart });
  app.confirmSelections({ order_id: "ord-dmg", pickup_time: null, flavor_selections: [{ flavor_id: "flv-lotus" }, { flavor_id: "flv-mixnut" }], allergens_acknowledged: ["wheat"], at: sellStart });
  app.payOrder({ order_id: "ord-dmg", at: sellStart });
  app.dispatchShipment({ order_id: "ord-dmg", shipment_id: "sh-dmg", bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-09-13T09:00:00+08:00" });
  app.deliverShipment({ order_id: "ord-dmg", shipment_id: "sh-dmg", at: "2026-09-14T14:00:00+08:00" });
  app.reportDamage({ order_id: "ord-dmg", damage_id: "dmg", units: 1, description: "香囊损坏", at: "2026-09-14T18:00:00+08:00" });

  // 已报损但补寄未签收：订单状态 damage_reported，不进入 9 月期清算
  assert.throws(
    () => app.settlePartner({ partner_id: "P-filigree", period, at: "2026-10-01T10:00:00+08:00" }),
    (err) => err.code === "NOTHING_TO_SETTLE"
  );

  // 补寄签收后可清算，履约完成时点为补寄签收时点
  app.shipReplacement({ order_id: "ord-dmg", damage_id: "dmg", replacement_id: "rep", units: 1, bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-10-03T09:00:00+08:00" });
  app.deliverReplacement({ order_id: "ord-dmg", replacement_id: "rep", at: "2026-10-04T10:00:00+08:00" });
  assert.throws(
    () => app.settlePartner({ partner_id: "P-filigree", period, at: "2026-10-05T10:00:00+08:00" }),
    (err) => err.code === "NOTHING_TO_SETTLE"
  );
  const octPeriod = { from: "2026-10-01T00:00:00+08:00", to: "2026-10-31T23:59:59+08:00" };
  const settled = app.settlePartner({ partner_id: "P-filigree", period: octPeriod, at: "2026-11-01T10:00:00+08:00" });
  assert.deepEqual(settled.lines.map((l) => l.order_id), ["ord-dmg"]);
});
