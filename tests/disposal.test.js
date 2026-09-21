import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld } from "./helpers/fixture.js";
import { availabilityForChannel } from "../src/app/projections.js";

const sellStart = "2026-09-11T10:00:00+08:00";
const deadline = "2026-09-12T22:00:00+08:00";

test("临期处置：短保批次报废，含该批次的组合批次同步处置；无关茶香礼不受影响", () => {
  const { app, repo, ids } = buildWorld();

  assert.equal(availabilityForChannel(repo, { channelId: "ch-offline", storeId: "S1" }, sellStart)[0].sellable, 25);

  // 五仁批次临期：裸批次剩余报废，含它的组合批次 A、B 同步处置
  app.disposeExpired({ lot_ids: [ids.lotMixnut], bundle_batch_ids: [ids.batchA, ids.batchB], at: "2026-10-10T10:00:00+08:00" });

  assert.equal(repo.lot(ids.lotMixnut).status, "scrapped");
  assert.equal(repo.bundleBatch(ids.batchA).status, "disposed");
  assert.equal(repo.bundleBatch(ids.batchB).status, "disposed");
  // 不含五仁的茶香礼批次不受影响
  assert.equal(repo.bundleBatch(ids.batchTea).status, "released");
});

test("已放行批次不能重复占用：铺货与补寄共享同一余量", () => {
  const { app, ids } = buildWorld();
  // A 批 30：门店 20、线上 4，机动余量 6
  assert.throws(
    () => app.supplyQuota({ quota_id: ids.quotaOnline, bundle_batch_id: ids.batchA, units: 7, supply_id: "sup-over", at: sellStart }),
    (err) => err.code === "INSUFFICIENT_SELLABLE" && err.meta.available === 6
  );
  assert.equal(app.repo.quotaVersion(ids.quotaOnline), 3); // 失败不留痕（开放 + 两条铺货）

  // 走一笔真实破损补寄占用 1 份后，剩余可铺货变 5
  app.reserveOrder({ order_id: "ord-d", quota_id: ids.quotaStore1, units: 1, fulfillment_type: "express", unit_price: 268, expires_at: deadline, at: sellStart });
  app.confirmSelections({ order_id: "ord-d", flavor_selections: [{ flavor_id: "flv-lotus" }, { flavor_id: "flv-mixnut" }], allergens_acknowledged: ["wheat"], at: sellStart });
  app.payOrder({ order_id: "ord-d", at: sellStart });
  app.dispatchShipment({ order_id: "ord-d", shipment_id: "sh-d", bundle_batch_id: ids.batchB, carrier: "SF", at: "2026-09-12T09:00:00+08:00" });
  app.deliverShipment({ order_id: "ord-d", shipment_id: "sh-d", at: "2026-09-12T18:00:00+08:00" });
  app.reportDamage({ order_id: "ord-d", damage_id: "dmg-d", units: 1, description: "压损", at: "2026-09-12T19:00:00+08:00" });
  app.shipReplacement({ order_id: "ord-d", damage_id: "dmg-d", replacement_id: "rep-d", units: 1, bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-09-13T09:00:00+08:00" });

  assert.throws(
    () => app.supplyQuota({ quota_id: ids.quotaOnline, bundle_batch_id: ids.batchA, units: 6, supply_id: "sup-over2", at: sellStart }),
    (err) => err.code === "INSUFFICIENT_SELLABLE" && err.meta.available === 5
  );
});
