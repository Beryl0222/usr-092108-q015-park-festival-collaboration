// 端到端中文演示：
//   node scripts/walkthrough.mjs
import { buildWorld } from "../tests/helpers/fixture.js";
import { availabilityForChannel, buildGenealogy, expiringFoodLots } from "../src/app/projections.js";

const line = (title) => console.log(`\n=== ${title} ===`);
const { app, repo, ids } = buildWorld();
const at = "2026-09-11T10:00:00+08:00";
const deadline = "2026-09-12T22:00:00+08:00";

line("1. 门店真实可售（非全网虚数）");
for (const row of availabilityForChannel(repo, { channelId: "ch-offline" }, at)) {
  console.log(`门店 ${row.store_id}：组合 ${row.bundle_id} 可售 ${row.sellable}，铺货批次 ${row.supplies.map((s) => s.bundle_batch_id).join("/")}`);
}
for (const row of availabilityForChannel(repo, { channelId: "ch-online" }, at)) {
  console.log(`线上：组合 ${row.bundle_id} 可售 ${row.sellable}`);
}

line("2. 预售保留 → 消费者确认 → 支付 → 自提");
app.reserveOrder({ order_id: "demo-1", quota_id: ids.quotaStore1, units: 2, fulfillment_type: "pickup", unit_price: 268, expires_at: deadline, partner_shares: { "P-park": 40, "P-filigree": 30 }, at });
console.log("保留后门店可售：", availabilityForChannel(repo, { channelId: "ch-offline", storeId: "S1" }, at)[0].sellable);
app.confirmSelections({ order_id: "demo-1", pickup_time: "2026-09-13T15:00:00+08:00", flavor_selections: [{ flavor_id: "flv-lotus" }, { flavor_id: "flv-mixnut" }], allergens_acknowledged: ["wheat", "egg", "nuts"], at });
app.payOrder({ order_id: "demo-1", at });
app.completePickup({ order_id: "demo-1", store_id: "S1", bundle_batch_id: ids.batchA, at: "2026-09-13T15:00:00+08:00" });
console.log("订单状态：", repo.order("demo-1").status);

line("3. 五仁口味检验异常：精确冻结");
app.failFlavorInspection({ recipe_id: ids.rMixnut, reason: "酸价超标", at: "2026-09-11T16:00:00+08:00" });
const freeze = app.quarantineFoodLot({ lot_id: ids.lotMixnut, reason: "五仁酸价超标", at: "2026-09-11T16:05:00+08:00" });
console.log("被冻结组合批次：", freeze.bundle_batches.join(", "));
console.log("香囊批次状态：", repo.lot(ids.lotSachet).status, "（未被冻结）");
console.log("茶饮批次状态：", repo.lot(ids.lotTea).status, "（未被冻结）");
console.log("茶香礼仍在售：", availabilityForChannel(repo, { channelId: "ch-online", bundleId: ids.bundleTea }, at)[0].sellable);

line("4. 从任一订单追溯食品批次与文创部件");
const trace = buildGenealogy(repo).traceOrder("demo-1");
console.log("组合批次：", trace.bundle_batch_ids.join(", "));
for (const l of trace.food_lots) console.log(`食品：${l.component_name} 批次 ${l.lot_id} 口味 ${l.flavor_id} 标签 ${l.label_code}`);
for (const l of trace.nonfood_lots) console.log(`文创：${l.component_name} 批次 ${l.lot_id} 设计版次 ${l.design_version_id}`);

line("5. 临期视图（30 天窗口）");
for (const l of expiringFoodLots(repo, buildGenealogy(repo), "2026-09-21T10:00:00+08:00", 30)) {
  console.log(`${l.component_name} 批次 ${l.lot_id} 到期 ${l.best_before}，所在组合 ${l.in_bundle_batches.join("/")}`);
}

line("6. 合作方按实际履约清算");
const park = app.settlePartner({ partner_id: "P-park", period: { from: "2026-09-01T00:00:00+08:00", to: "2026-09-30T23:59:59+08:00" }, at: "2026-10-01T10:00:00+08:00" });
console.log(`公园合作方清算 ${park.lines.length} 单，合计 ${park.amount} 元：${park.lines.map((l) => l.order_id).join(", ")}`);

line("7. 已售批次保留当时授权依据（授权随后收窄也不回溯）");
const basis = repo.lot(ids.lotSachet).licenseBasis;
console.log("香囊批次固化的授权快照：", basis.map((b) => `${b.element_id}@${b.license_id}(${b.scope_mode}, as_of ${b.as_of})`).join("；"));
app.narrowLicense({ license_id: ids.licPavilion, design_version_ids: [], reason: "旧版停止新生产", at: "2026-09-20T10:00:00+08:00" });
console.log("收窄后该已售批次仍保留", repo.lot(ids.lotSachet).licenseBasis.length, "条授权快照；旧版新生产的部件会被拒绝");
