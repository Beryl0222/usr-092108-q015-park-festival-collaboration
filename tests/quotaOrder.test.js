import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld, T } from "./helpers/fixture.js";
import { availabilityForChannel } from "../src/app/projections.js";
import { sellableUnits } from "../src/domain/channelQuota.js";

const sellStart = "2026-09-11T10:00:00+08:00";
const deadline = "2026-09-12T22:00:00+08:00";

test("门店看到真实可售而非全网虚数：门店与线上各自独立，保留扣减、释放回收", () => {
  const { app, repo, ids } = buildWorld();

  const storeRows = availabilityForChannel(repo, { channelId: "ch-offline", storeId: "S1", bundleId: ids.bundleGift }, sellStart);
  assert.equal(storeRows.length, 1);
  assert.equal(storeRows[0].sellable, 25); // 20(A)+5(B)
  const onlineRows = availabilityForChannel(repo, { channelId: "ch-online", bundleId: ids.bundleGift }, sellStart);
  assert.equal(onlineRows[0].sellable, 9); // 4(A)+5(B)

  // 门店预售 8 份
  app.reserveOrder({ order_id: "ord-s1-1", quota_id: ids.quotaStore1, units: 8, fulfillment_type: "pickup", unit_price: 268, expires_at: deadline, at: sellStart });
  assert.equal(availabilityForChannel(repo, { channelId: "ch-offline", storeId: "S1" }, sellStart)[0].sellable, 17);
  // 线上可售完全不受影响
  assert.equal(availabilityForChannel(repo, { channelId: "ch-online" }, sellStart).find((r) => r.bundle_id === ids.bundleGift).sellable, 9);

  // 取消订单：配额安全回收
  app.cancelOrder({ order_id: "ord-s1-1", reason: "customer_cancelled", at: "2026-09-11T12:00:00+08:00" });
  assert.equal(availabilityForChannel(repo, { channelId: "ch-offline", storeId: "S1" }, sellStart)[0].sellable, 25);
  assert.equal(repo.order("ord-s1-1").status, "cancelled");
});

test("预售超过门店真实可售直接拒绝超卖，失败不留任何保留或订单", () => {
  const { app, repo, ids } = buildWorld();
  assert.throws(
    () => app.reserveOrder({ order_id: "ord-over", quota_id: ids.quotaStore1, units: 26, fulfillment_type: "pickup", expires_at: deadline, at: sellStart }),
    (err) => err.code === "INSUFFICIENT_SELLABLE" && err.meta.available === 25 && err.meta.requested === 26
  );
  assert.equal(repo.orderVersion("ord-over"), 0);
  const quota = repo.quota(ids.quotaStore1);
  assert.equal(quota.reservations.size, 0);
});

test("迟到支付：保留过期后支付被拒且安全释放，释放出的额度可被新订单使用", () => {
  const { app, repo, ids } = buildWorld();
  app.reserveOrder({ order_id: "ord-late", quota_id: ids.quotaStore1, units: 25, fulfillment_type: "pickup", unit_price: 268, expires_at: deadline, at: sellStart });
  assert.equal(sellableUnits(repo.quota(ids.quotaStore1), sellStart), 0);

  // 到达过期时刻：held 不再计入占用，可售自动恢复 25；定时任务负责把订单取消、保留落账为 released
  assert.equal(sellableUnits(repo.quota(ids.quotaStore1), deadline), 25);
  const expired = app.autoExpireReservations(deadline);
  assert.deepEqual(expired, ["ord-late"]);
  assert.equal(repo.order("ord-late").status, "cancelled");
  const lateRsv = repo.quota(ids.quotaStore1).reservations.get(repo.order("ord-late").reservationId);
  assert.equal(lateRsv.status, "released");
  assert.equal(sellableUnits(repo.quota(ids.quotaStore1), deadline), 25);

  // 迟到支付被明确拒绝，且不会二次扣配额
  assert.throws(
    () => app.payOrder({ order_id: "ord-late", at: "2026-09-12T23:00:00+08:00" }),
    (err) => err.code === "RESERVATION_EXPIRED"
  );

  // 释放出的 25 份可被新预售使用
  app.reserveOrder({ order_id: "ord-new", quota_id: ids.quotaStore1, units: 25, fulfillment_type: "pickup", unit_price: 268, expires_at: "2026-09-14T22:00:00+08:00", at: deadline });
  app.payOrder({ order_id: "ord-new", at: "2026-09-13T10:00:00+08:00" });
  assert.equal(repo.order("ord-new").paid, true);
});

test("消费者确认取货时间、口味与过敏原后才可自提", () => {
  const { app, repo, ids } = buildWorld();
  app.reserveOrder({ order_id: "ord-pick", quota_id: ids.quotaStore1, units: 1, fulfillment_type: "pickup", unit_price: 268, expires_at: deadline, at: sellStart });
  // 未确认选择不能自提
  app.payOrder({ order_id: "ord-pick", at: "2026-09-11T11:00:00+08:00" });
  assert.throws(() => app.completePickup({ order_id: "ord-pick", store_id: "S1", bundle_batch_id: ids.batchA, at: "2026-09-13T10:00:00+08:00" }), /尚未确认/);

  // 选择了组合里不存在的口味被拒
  assert.throws(
    () => app.confirmSelections({ order_id: "ord-pick", pickup_time: "2026-09-13T15:00:00+08:00", flavor_selections: [{ flavor_id: "flv-not-exist" }], allergens_acknowledged: ["wheat", "egg", "nuts"], at: "2026-09-11T11:30:00+08:00" }),
    (err) => err.code === "UNKNOWN_FLAVOR"
  );

  app.confirmSelections({
    order_id: "ord-pick", pickup_time: "2026-09-13T15:00:00+08:00",
    flavor_selections: [{ flavor_id: "flv-lotus" }, { flavor_id: "flv-mixnut" }],
    allergens_acknowledged: ["wheat", "egg", "nuts"], at: "2026-09-11T11:30:00+08:00"
  });
  app.completePickup({ order_id: "ord-pick", store_id: "S1", bundle_batch_id: ids.batchA, at: "2026-09-13T15:00:00+08:00" });
  assert.equal(repo.order("ord-pick").status, "fulfilled");
});
