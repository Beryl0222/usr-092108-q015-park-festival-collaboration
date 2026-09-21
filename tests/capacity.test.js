import assert from "node:assert/strict";
import test from "node:test";

import { FulfillmentApp } from "../src/app/fulfillmentApp.js";
import { DomainError } from "../src/domain/errors.js";
import { remainingByMode } from "../src/domain/capacity.js";
import { buildWorld, T } from "./helpers/fixture.js";

test("900 克手工产品与标准礼盒产能分账，互不挤占", () => {
  const { app, repo, ids } = buildWorld();
  const capacity = repo.capacity;
  // 手工 50 用了 40（莲蓉），标准 200 用了 100+100（五仁、茶饮）
  assert.equal(remainingByMode(capacity, "handmade_900g"), 10);
  assert.equal(remainingByMode(capacity, "standard"), 0);
  // 手工有余量但标准为 0：再生产标准件必须被拒，不能借用手工产能
  assert.throws(
    () => app.produceFoodBatch({
      component_id: "comp-tea", component_name: "桂花乌龙茶",
      recipe_id: ids.rTea, factory_id: "F1", production_date: T.d5, units: 1,
      produced_at: T.produced, best_before: "2026-12-31T23:59:59+08:00", at: T.produced
    }),
    (err) => err instanceof DomainError && err.code === "CAPACITY_EXCEEDED"
  );
});

test("手工产能用尽后再生产 900 克产品被拒，加申报后恢复", () => {
  const { app, ids } = buildWorld();
  // 余量 10，申请 11 被拒
  assert.throws(
    () => app.produceFoodBatch({
      lot_id: "lot-lotus-over", component_id: "comp-moon-lotus", component_name: "莲蓉月饼",
      recipe_id: ids.rLotus, factory_id: "F1", production_date: T.d5, units: 11,
      produced_at: T.produced, best_before: T.bestBefore, at: T.produced
    }),
    (err) => err.code === "CAPACITY_EXCEEDED" && err.meta.remaining === 10
  );
  // 同一事务失败不留痕：批次流不存在，产能未被扣减
  assert.equal(app.repo.lotVersion("lot-lotus-over"), 0);

  app.declareCapacity({ production_mode: "handmade_900g", factory_id: "F1", production_date: "2026-09-06", units: 20, at: T.produced });
  const lot = app.produceFoodBatch({
    lot_id: "lot-lotus-more", component_id: "comp-moon-lotus", component_name: "莲蓉月饼",
    recipe_id: ids.rLotus, factory_id: "F1", production_date: "2026-09-06", units: 15,
    produced_at: T.produced, best_before: T.bestBefore, at: T.produced
  });
  assert.equal(lot, "lot-lotus-more");
});
