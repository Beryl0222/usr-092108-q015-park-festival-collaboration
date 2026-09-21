// 搭建一个贴近题述场景的中秋联名世界：
// 古建纹样授权 + 花丝香囊 + 节令茶饮 + 两种口味月饼 + 祝福卡，
// 含两个组合（中秋礼盒、茶香礼盒）、两家门店/渠道。
import { FulfillmentApp } from "../../src/app/fulfillmentApp.js";
import { EventStore } from "../../src/app/eventStore.js";

export const T = {
  t0: "2026-09-01T09:00:00+08:00",
  d5: "2026-09-05",
  label: "2026-09-02T10:00:00+08:00",
  produced: "2026-09-06T10:00:00+08:00",
  assembled: "2026-09-08T10:00:00+08:00",
  released: "2026-09-09T10:00:00+08:00",
  selling: "2026-09-10T10:00:00+08:00",
  bestBefore: "2026-10-15T23:59:59+08:00"
};

export function buildWorld(options = {}) {
  const app = new FulfillmentApp({ store: options.store ?? new EventStore() });
  const repo = app.repo;

  // 联名与元素授权
  const collabId = app.registerCollaboration({ collaboration_id: "collab-midautumn", name: "公园中秋联名", at: T.t0 });
  const licPavilion = app.licenseElement({
    license_id: "lic-pavilion", collaboration_id: collabId, element_id: "el-pavilion", element_name: "古建斗拱纹样",
    partner_id: "P-park", valid_from: "2026-08-01T00:00:00+08:00", valid_to: "2026-12-31T23:59:59+08:00", at: T.t0
  });
  const licFiligree = app.licenseElement({
    license_id: "lic-filigree", collaboration_id: collabId, element_id: "el-filigree", element_name: "花丝工艺",
    partner_id: "P-filigree", valid_from: "2026-08-01T00:00:00+08:00", valid_to: "2026-12-31T23:59:59+08:00", at: T.t0
  });
  app.clearDesignVersion({
    collaboration_id: collabId, design_version_id: "dv-2026-01", design_id: "design-giftbox", version: 1,
    cultural_element_ids: ["el-pavilion", "el-filigree"], at: T.t0
  });

  // 配方：莲蓉（900 克手工）、五仁（标准）、节令茶饮（标准）
  const rLotus = app.registerRecipe({
    recipe_id: "recipe-lotus", name: "莲蓉月饼", flavor_id: "flv-lotus", flavor_name: "莲蓉",
    recipe_version: "rv-1", allergens: ["wheat", "egg"], weight_grams: 900, production_mode: "handmade_900g", at: T.t0
  });
  const rMixnut = app.registerRecipe({
    recipe_id: "recipe-mixnut", name: "五仁月饼", flavor_id: "flv-mixnut", flavor_name: "五仁",
    recipe_version: "rv-1", allergens: ["wheat", "nuts"], weight_grams: 600, production_mode: "standard", at: T.t0
  });
  const rTea = app.registerRecipe({
    recipe_id: "recipe-tea", name: "桂花乌龙茶", flavor_id: "flv-osmanthus", flavor_name: "桂花乌龙",
    recipe_version: "rv-1", allergens: [], weight_grams: 200, production_mode: "standard", at: T.t0
  });

  // 标签：V1 覆盖三种食品
  app.approveLabel({
    label_code: "LBL-2026-V1", label_version: 1, applies_to_recipe_ids: [rLotus, rMixnut, rTea], at: T.label
  });

  // 产能：手工与标准分账
  app.declareCapacity({ production_mode: "handmade_900g", factory_id: "F1", production_date: T.d5, units: 50, at: T.t0 });
  app.declareCapacity({ production_mode: "standard", factory_id: "F1", production_date: T.d5, units: 200, at: T.t0 });

  // 食品批次
  const lotLotus = app.produceFoodBatch({
    lot_id: "lot-lotus-0906", component_id: "comp-moon-lotus", component_name: "莲蓉月饼",
    recipe_id: rLotus, factory_id: "F1", production_date: T.d5, units: 40, produced_at: T.produced, best_before: T.bestBefore, at: T.produced
  });
  const lotMixnut = app.produceFoodBatch({
    lot_id: "lot-mixnut-0906", component_id: "comp-moon-mixnut", component_name: "五仁月饼",
    recipe_id: rMixnut, factory_id: "F1", production_date: T.d5, units: 100, produced_at: T.produced, best_before: T.bestBefore, at: T.produced
  });
  const lotTea = app.produceFoodBatch({
    lot_id: "lot-tea-0906", component_id: "comp-tea", component_name: "桂花乌龙茶",
    recipe_id: rTea, factory_id: "F1", production_date: T.d5, units: 100, produced_at: T.produced, best_before: "2026-12-31T23:59:59+08:00", at: T.produced
  });

  // 非食品部件（香囊、祝福卡），入库时固化授权依据
  const lotSachet = app.receiveNonfoodComponent({
    lot_id: "lot-sachet-0901", collaboration_id: collabId, design_version_id: "dv-2026-01",
    component_id: "comp-sachet", component_name: "花丝香囊", supplier_partner_id: "P-filigree", units: 100, received_at: T.produced, at: T.produced
  });
  const lotCard = app.receiveNonfoodComponent({
    lot_id: "lot-card-0901", collaboration_id: collabId, design_version_id: "dv-2026-01",
    component_id: "comp-card", component_name: "中秋祝福卡", units: 100, customization: { type: "printed_blessing", variants: ["default"] }, received_at: T.produced, at: T.produced
  });

  // 组合定义
  const bundleGift = app.defineBundle({
    bundle_id: "bundle-gift", name: "中秋圆满礼盒", collaboration_id: collabId, design_version_id: "dv-2026-01",
    production_mode: "standard", flavor_ids: ["flv-lotus", "flv-mixnut"],
    components: [
      { componentId: "comp-moon-lotus", units_per_bundle: 1 },
      { componentId: "comp-moon-mixnut", units_per_bundle: 1 },
      { componentId: "comp-tea", units_per_bundle: 1 },
      { componentId: "comp-sachet", units_per_bundle: 1 },
      { componentId: "comp-card", units_per_bundle: 1 }
    ],
    at: T.t0
  });
  const bundleTea = app.defineBundle({
    bundle_id: "bundle-tea", name: "茶香文创礼", collaboration_id: collabId, design_version_id: "dv-2026-01",
    production_mode: "standard", flavor_ids: ["flv-osmanthus"],
    components: [
      { componentId: "comp-tea", units_per_bundle: 1 },
      { componentId: "comp-sachet", units_per_bundle: 1 },
      { componentId: "comp-card", units_per_bundle: 1 }
    ],
    at: T.t0
  });

  // 装配：礼盒 A 30 份、B 10 份（莲蓉 40 份正好用尽）；茶香礼 10 份
  const batchA = app.assembleBundleBatch({
    bundle_batch_id: "bbatch-A", bundle_id: bundleGift, units: 30,
    component_lot_ids: [lotLotus, lotMixnut, lotTea, lotSachet, lotCard], at: T.assembled
  });
  const batchB = app.assembleBundleBatch({
    bundle_batch_id: "bbatch-B", bundle_id: bundleGift, units: 10,
    component_lot_ids: [lotLotus, lotMixnut, lotTea, lotSachet, lotCard], at: T.assembled
  });
  const batchTea = app.assembleBundleBatch({
    bundle_batch_id: "bbatch-TEA", bundle_id: bundleTea, units: 10,
    component_lot_ids: [lotTea, lotSachet, lotCard], at: T.assembled
  });

  // 放行闸口
  app.releaseBundleBatch({ bundle_batch_id: batchA, units: 30, at: T.released });
  app.releaseBundleBatch({ bundle_batch_id: batchB, units: 10, at: T.released });
  app.releaseBundleBatch({ bundle_batch_id: batchTea, units: 10, at: T.released });

  // 渠道配额：门店 S1 25 份（A20+B5），线上 9 份（A4+B5）；茶香礼线上 6，剩 A6/茶香4 作机动
  const quotaStore1 = app.openQuota({ quota_id: "quota-store1", channel_id: "ch-offline", store_id: "S1", bundle_id: bundleGift, at: T.selling });
  const quotaOnline = app.openQuota({ quota_id: "quota-online", channel_id: "ch-online", store_id: null, bundle_id: bundleGift, at: T.selling });
  const quotaOnlineTea = app.openQuota({ quota_id: "quota-online-tea", channel_id: "ch-online", store_id: null, bundle_id: bundleTea, at: T.selling });
  app.supplyQuota({ quota_id: quotaStore1, bundle_batch_id: batchA, units: 20, supply_id: "sup-s1-a", at: T.selling });
  app.supplyQuota({ quota_id: quotaStore1, bundle_batch_id: batchB, units: 5, supply_id: "sup-s1-b", at: T.selling });
  app.supplyQuota({ quota_id: quotaOnline, bundle_batch_id: batchA, units: 4, supply_id: "sup-on-a", at: T.selling });
  app.supplyQuota({ quota_id: quotaOnline, bundle_batch_id: batchB, units: 5, supply_id: "sup-on-b", at: T.selling });
  app.supplyQuota({ quota_id: quotaOnlineTea, bundle_batch_id: batchTea, units: 6, supply_id: "sup-on-tea", at: T.selling });

  return {
    app, repo,
    ids: {
      collabId, licPavilion, licFiligree,
      rLotus, rMixnut, rTea,
      lotLotus, lotMixnut, lotTea, lotSachet, lotCard,
      bundleGift, bundleTea, batchA, batchB, batchTea,
      quotaStore1, quotaOnline, quotaOnlineTea
    }
  };
}
