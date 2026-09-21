import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld, T } from "./helpers/fixture.js";

test("部件不齐不能装配：缺香囊/缺月饼直接拒绝，且不占用任何批次", () => {
  const { app, repo, ids } = buildWorld();
  const before = repo.lot(ids.lotSachet).qtyAllocated;
  assert.throws(
    () => app.assembleBundleBatch({
      bundle_batch_id: "bbatch-short", bundle_id: ids.bundleGift, units: 100,
      component_lot_ids: [ids.lotLotus, ids.lotMixnut, ids.lotTea, ids.lotSachet, ids.lotCard],
      at: T.assembled
    }),
    (err) => err.code === "INSUFFICIENT_COMPONENTS"
  );
  // 事务整体失败：组合批次不存在，香囊批次占用量不变
  assert.equal(repo.bundleBatchVersion("bbatch-short"), 0);
  assert.equal(repo.lot(ids.lotSachet).qtyAllocated, before);
});

test("标签撤版后未放行批次被闸口拦下，换装当前标签后才可放行", () => {
  const { app, repo } = buildWorld();
  // 标签 V1 撤版、V2 批准（覆盖全部三种配方），发生在既有批次已放行之后
  app.withdrawLabel({ label_code: "LBL-2026-V1", at: "2026-09-09T18:00:00+08:00" });
  app.approveLabel({
    label_code: "LBL-2026-V2", label_version: 2,
    applies_to_recipe_ids: ["recipe-lotus", "recipe-mixnut", "recipe-tea"], at: "2026-09-09T19:00:00+08:00"
  });

  // 再造一份新组合：需要一份新莲蓉（为 09-06 补申报手工产能）与既有其他部件
  app.declareCapacity({ production_mode: "handmade_900g", factory_id: "F1", production_date: "2026-09-06", units: 5, at: "2026-09-09T19:10:00+08:00" });
  const lotLotus2 = app.produceFoodBatch({
    lot_id: "lot-lotus-v2label", component_id: "comp-moon-lotus", component_name: "莲蓉月饼",
    recipe_id: "recipe-lotus", factory_id: "F1", production_date: "2026-09-06", units: 1,
    produced_at: "2026-09-09T19:30:00+08:00", best_before: T.bestBefore,
    at: "2026-09-09T19:30:00+08:00"
  });
  assert.equal(repo.lot(lotLotus2).labelCode, "LBL-2026-V2");

  const batchC = app.assembleBundleBatch({
    bundle_batch_id: "bbatch-C", bundle_id: "bundle-gift", units: 1,
    component_lot_ids: [lotLotus2, "lot-mixnut-0906", "lot-tea-0906", "lot-sachet-0901", "lot-card-0901"],
    at: "2026-09-09T20:00:00+08:00"
  });

  // 新批次的五仁/茶饮仍挂已撤版的 V1：放行被拦下，且问题只在标签
  assert.throws(
    () => app.releaseBundleBatch({ bundle_batch_id: batchC, at: "2026-09-09T21:00:00+08:00" }),
    (err) => {
      if (err.code !== "RELEASE_BLOCKED") return false;
      const kinds = err.meta.problems.map((p) => p.kind);
      return kinds.includes("label_not_current") && !kinds.includes("missing_component");
    }
  );

  // 换装 V2 后放行通过
  app.refreshLotLabel({ lot_id: "lot-mixnut-0906", label_code: "LBL-2026-V2", at: "2026-09-09T21:30:00+08:00" });
  app.refreshLotLabel({ lot_id: "lot-tea-0906", label_code: "LBL-2026-V2", at: "2026-09-09T21:30:00+08:00" });
  app.releaseBundleBatch({ bundle_batch_id: batchC, at: "2026-09-09T22:00:00+08:00" });
  assert.equal(repo.bundleBatch(batchC).status, "released");
});

test("食品临期：已装配批次到放行时过期，闸口以 lot_expired 拦下", () => {
  const { app, repo } = buildWorld();
  app.declareCapacity({ production_mode: "handmade_900g", factory_id: "F1", production_date: "2026-09-06", units: 5, at: "2026-09-08T07:00:00+08:00" });
  // 一份短保莲蓉：8 日装配、10 日到期、12 日才申请放行
  const lotShort = app.produceFoodBatch({
    lot_id: "lot-lotus-short", component_id: "comp-moon-lotus", component_name: "莲蓉月饼（短保）",
    recipe_id: "recipe-lotus", factory_id: "F1", production_date: "2026-09-06", units: 1,
    produced_at: "2026-09-08T08:00:00+08:00", best_before: "2026-09-10T23:59:59+08:00",
    at: "2026-09-08T08:00:00+08:00"
  });
  const batchD = app.assembleBundleBatch({
    bundle_batch_id: "bbatch-D", bundle_id: "bundle-gift", units: 1,
    component_lot_ids: [lotShort, "lot-mixnut-0906", "lot-tea-0906", "lot-sachet-0901", "lot-card-0901"],
    at: "2026-09-08T10:00:00+08:00"
  });
  assert.throws(
    () => app.releaseBundleBatch({ bundle_batch_id: batchD, at: "2026-09-12T10:00:00+08:00" }),
    (err) => err.code === "RELEASE_BLOCKED" && err.meta.problems.some((p) => p.kind === "lot_expired")
  );
});
