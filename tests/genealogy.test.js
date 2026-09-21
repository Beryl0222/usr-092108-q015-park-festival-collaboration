import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld, T } from "./helpers/fixture.js";
import { buildGenealogy, expiringFoodLots } from "../src/app/projections.js";
import { availabilityForChannel } from "../src/app/projections.js";

const sellStart = "2026-09-11T10:00:00+08:00";
const deadline = "2026-09-12T22:00:00+08:00";

test("某口味检验异常：只冻结含该口味的组合与订单，香囊、茶饮和茶香礼不受影响", () => {
  const { app, repo, ids } = buildWorld();

  // 两笔茶香礼订单（与五仁完全无关）
  app.reserveOrder({ order_id: "ord-tea-1", quota_id: ids.quotaOnlineTea, units: 1, fulfillment_type: "express", unit_price: 168, expires_at: deadline, partner_shares: { "P-filigree": 10 }, at: sellStart });
  app.payOrder({ order_id: "ord-tea-1", at: sellStart });
  app.reserveOrder({ order_id: "ord-tea-2", quota_id: ids.quotaOnlineTea, units: 1, fulfillment_type: "express", unit_price: 168, expires_at: deadline, at: sellStart });

  // 一笔含五仁的礼盒订单（已支付）
  app.reserveOrder({ order_id: "ord-gift-1", quota_id: ids.quotaOnline, units: 1, fulfillment_type: "express", unit_price: 268, expires_at: deadline, partner_shares: { "P-park": 20, "P-filigree": 15 }, at: sellStart });
  app.payOrder({ order_id: "ord-gift-1", at: sellStart });

  // 五仁口味检验异常 → 冻结五仁批次
  app.failFlavorInspection({ recipe_id: ids.rMixnut, reason: "酸价超标", at: "2026-09-11T16:00:00+08:00" });
  const result = app.quarantineFoodLot({ lot_id: ids.lotMixnut, reason: "五仁酸价超标", at: "2026-09-11T16:05:00+08:00" });

  // 只命中含五仁的组合批次 A、B；茶香礼 TEA 不在其中
  assert.deepEqual(result.bundle_batches.sort(), ["bbatch-A", "bbatch-B"]);
  assert.deepEqual(result.order_ids, ["ord-gift-1"]);

  // 香囊与茶饮批次没有被冻结
  assert.equal(repo.lot(ids.lotSachet).status, "accepted");
  assert.equal(repo.lot(ids.lotSachet).qtyQuarantined, 0);
  assert.equal(repo.lot(ids.lotTea).status, "accepted");
  assert.equal(repo.lot(ids.lotTea).qtyQuarantined, 0);

  // 含问题口味的订单挂起，不能发货
  assert.equal(repo.order("ord-gift-1").status, "held");
  assert.throws(() => app.dispatchShipment({ order_id: "ord-gift-1", shipment_id: "sh-1", bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-09-12T09:00:00+08:00" }), /冻结/);

  // 茶香礼订单与渠道完全不受影响：仍可发货；其配额上两笔订单各占 1，可售 6−2=4
  assert.equal(repo.order("ord-tea-1").status, "paid");
  app.dispatchShipment({ order_id: "ord-tea-1", shipment_id: "sh-tea-1", bundle_batch_id: ids.batchTea, carrier: "SF", at: "2026-09-12T09:00:00+08:00" });
  assert.equal(availabilityForChannel(repo, { channelId: "ch-online", bundleId: ids.bundleTea }, "2026-09-12T09:00:00+08:00")[0].sellable, 4);

  // 门店与线上礼盒可售均已归零（铺货随问题批次冻结，且不是全网一刀切——茶香礼仍在售）
  assert.equal(availabilityForChannel(repo, { channelId: "ch-offline", storeId: "S1" }, "2026-09-12T09:00:00+08:00")[0].sellable, 0);
  assert.equal(availabilityForChannel(repo, { channelId: "ch-online", bundleId: ids.bundleGift }, "2026-09-12T09:00:00+08:00")[0].sellable, 0);
});

test("谱系投影：口味→食品批次→组合批次→订单，以及订单→食品批次/文创部件双向可追", () => {
  const { repo, ids } = buildWorld();
  const g = buildGenealogy(repo);

  const mixnutImpact = g.impactOfFlavor("flv-mixnut");
  assert.deepEqual(mixnutImpact.lot_ids, [ids.lotMixnut]);
  assert.deepEqual(mixnutImpact.bundle_batch_ids.sort(), [ids.batchA, ids.batchB]);

  const teaImpact = g.impactOfFlavor("flv-osmanthus");
  assert.deepEqual(teaImpact.lot_ids, [ids.lotTea]);
  assert.deepEqual(teaImpact.bundle_batch_ids.sort(), [ids.batchA, ids.batchB, ids.batchTea]);

  // 从订单反向追溯（先模拟一笔已绑定批次 A 的自提订单事件结果由投影直接验证索引）
  // 这里直接用已装配谱系断言 lot→batches 完整
  assert.deepEqual([...g.lotToBatches.get(ids.lotSachet)].sort(), [ids.batchA, ids.batchB, ids.batchTea]);
});

test("召回：从任一订单追到具体食品批次与文创部件；已签收订单也收到召回通知", () => {
  const { app, repo, ids } = buildWorld();

  app.reserveOrder({ order_id: "ord-express", quota_id: ids.quotaStore1, units: 1, fulfillment_type: "express", unit_price: 268, expires_at: deadline, partner_shares: { "P-park": 20, "P-filigree": 15 }, at: sellStart });
  app.confirmSelections({ order_id: "ord-express", pickup_time: null, flavor_selections: [{ flavor_id: "flv-lotus" }, { flavor_id: "flv-mixnut" }], allergens_acknowledged: ["wheat", "egg", "nuts"], at: sellStart });
  app.payOrder({ order_id: "ord-express", at: sellStart });
  app.dispatchShipment({ order_id: "ord-express", shipment_id: "sh-1", bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-09-12T09:00:00+08:00" });
  app.deliverShipment({ order_id: "ord-express", shipment_id: "sh-1", at: "2026-09-13T14:00:00+08:00" });

  // 运输破损报损，从机动库存补寄（A 批已铺货 24，余 6 可补）
  app.reportDamage({ order_id: "ord-express", damage_id: "dmg-1", units: 1, description: "外盒压坏、香囊受损", at: "2026-09-13T18:00:00+08:00" });
  app.shipReplacement({ order_id: "ord-express", damage_id: "dmg-1", replacement_id: "rep-1", units: 1, bundle_batch_id: ids.batchA, carrier: "SF", at: "2026-09-14T09:00:00+08:00" });
  app.deliverReplacement({ order_id: "ord-express", replacement_id: "rep-1", at: "2026-09-15T11:00:00+08:00" });
  assert.equal(repo.order("ord-express").status, "fulfilled");

  // 从订单追溯：食品三件 + 文创两件，食品带口味/过敏原/标签，文创带设计版次
  const trace = buildGenealogy(repo).traceOrder("ord-express");
  const foodNames = trace.food_lots.map((l) => l.component_name).sort();
  assert.deepEqual(foodNames, ["五仁月饼", "桂花乌龙茶", "莲蓉月饼"]);
  const nonfoodNames = trace.nonfood_lots.map((l) => l.component_name).sort();
  assert.deepEqual(nonfoodNames, ["中秋祝福卡", "花丝香囊"]);
  const sachetLine = trace.nonfood_lots.find((l) => l.component_name === "花丝香囊");
  assert.equal(sachetLine.design_version_id, "dv-2026-01");
  const lotusLine = trace.food_lots.find((l) => l.component_name === "莲蓉月饼");
  assert.equal(lotusLine.flavor_id, "flv-lotus");
  assert.deepEqual([...lotusLine.allergens].sort(), ["egg", "wheat"]);
  assert.equal(lotusLine.label_code, "LBL-2026-V1");

  // 从莲蓉批次反向追订单，补寄链路同样可追
  assert.ok(buildGenealogy(repo).ordersForLot(ids.lotLotus).includes("ord-express"));

  // 发起莲蓉批次召回：已签收订单也必须收到通知
  const recall = app.recall({ lot_ids: [ids.lotLotus], reason: "微生物抽检异常", at: "2026-09-16T10:00:00+08:00" });
  assert.deepEqual(recall.bundle_batch_ids.sort(), [ids.batchA, ids.batchB]);
  assert.deepEqual(recall.order_ids, ["ord-express"]);
  assert.equal(repo.order("ord-express").recalls.length, 1);

  app.completeRemedy({ order_id: "ord-express", remedy_id: "rm-1", remedy_type: "refund_and_recover", at: "2026-09-16T15:00:00+08:00" });
  assert.equal(repo.order("ord-express").status, "recall_remedied");
});

test("临期视图：按到期窗口列出食品批次及其下游组合与订单", () => {
  const { repo } = buildWorld();
  const g = buildGenealogy(repo);
  // 9 月 21 日往前看 30 天（截止 10-21）：10-15 到期的莲蓉/五仁在列，12-31 的茶饮不在
  const expiring = expiringFoodLots(repo, g, "2026-09-21T10:00:00+08:00", 30);
  const lotIds = expiring.map((l) => l.lot_id).sort();
  assert.deepEqual(lotIds, ["lot-lotus-0906", "lot-mixnut-0906"]);
  assert.ok(expiring.every((l) => l.in_bundle_batches.length > 0));
});
