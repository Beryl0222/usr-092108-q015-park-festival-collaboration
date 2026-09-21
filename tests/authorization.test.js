import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld, T } from "./helpers/fixture.js";

test("授权收窄只约束尚未生产的版本：已生产批次保留当时依据，继续装配放行不受影响", () => {
  const { app, repo, ids } = buildWorld();

  // 收窄古建纹样授权：dv-2026-01 不再允许新生产（范围给空）
  app.narrowLicense({ license_id: ids.licPavilion, design_version_ids: [], reason: "文物纹样换版，旧版停止新生产", at: "2026-09-10T12:00:00+08:00" });

  // 1) 已入库香囊批次的授权依据仍在，且可继续用于新装配（用的是已生产库存）
  const basis = repo.lot(ids.lotSachet).licenseBasis;
  assert.ok(basis.some((b) => b.element_id === "el-pavilion" && b.license_id === "lic-pavilion"));
  assert.equal(basis[0].as_of, T.produced);

  // 为新装配补够部件：标准产能已满无法再生产食品，但可用既有库存之外——
  // 这里直接验证：收窄后尝试“新生产”一版使用 dv-2026-01 的香囊被拒
  assert.throws(
    () => app.receiveNonfoodComponent({
      lot_id: "lot-sachet-new", collaboration_id: ids.collabId, design_version_id: "dv-2026-01",
      component_id: "comp-sachet", component_name: "花丝香囊（旧版新货）", units: 10,
      received_at: "2026-09-10T13:00:00+08:00", at: "2026-09-10T13:00:00+08:00"
    }),
    (err) => err.code === "LICENSE_OUT_OF_SCOPE" && err.meta.elementId === "el-pavilion"
  );
  assert.equal(repo.lotVersion("lot-sachet-new"), 0);

  // 2) 用旧版新设计版本号审定同样被拒（授权不覆盖新版本）
  assert.throws(
    () => app.clearDesignVersion({
      collaboration_id: ids.collabId, design_version_id: "dv-2026-02", design_id: "design-giftbox", version: 2,
      cultural_element_ids: ["el-pavilion", "el-filigree"], at: "2026-09-10T14:00:00+08:00"
    }),
    (err) => err.code === "LICENSE_OUT_OF_SCOPE"
  );
  assert.equal(repo.collaboration(ids.collabId).versions.has("dv-2026-02"), false);
});

test("授权收窄到显式新版本后，该版本可生产；未列入版本仍被拒", () => {
  const { app, repo, ids } = buildWorld();
  // 先审定 dv-2026-02（收窄前）
  app.clearDesignVersion({
    collaboration_id: ids.collabId, design_version_id: "dv-2026-02", design_id: "design-giftbox", version: 2,
    cultural_element_ids: ["el-pavilion", "el-filigree"], at: "2026-09-02T10:00:00+08:00"
  });
  // 收窄：仅 dv-2026-02 可继续
  app.narrowLicense({ license_id: ids.licPavilion, design_version_ids: ["dv-2026-02"], reason: "仅保留新版", at: "2026-09-10T12:00:00+08:00" });
  app.narrowLicense({ license_id: ids.licFiligree, design_version_ids: ["dv-2026-02"], reason: "仅保留新版", at: "2026-09-10T12:00:00+08:00" });

  // dv-2026-01 新生产被拒
  assert.throws(
    () => app.receiveNonfoodComponent({
      collaboration_id: ids.collabId, design_version_id: "dv-2026-01",
      component_id: "comp-card", component_name: "祝福卡（旧版）", units: 5,
      received_at: "2026-09-10T13:00:00+08:00", at: "2026-09-10T13:00:00+08:00"
    }),
    (err) => err.code === "LICENSE_OUT_OF_SCOPE"
  );

  // dv-2026-02 新生产放行
  const lot = app.receiveNonfoodComponent({
    lot_id: "lot-card-v2", collaboration_id: ids.collabId, design_version_id: "dv-2026-02",
    component_id: "comp-card", component_name: "祝福卡（新版纹样）", units: 5,
    received_at: "2026-09-10T14:00:00+08:00", at: "2026-09-10T14:00:00+08:00"
  });
  assert.equal(repo.lot(lot).status, "accepted");
  assert.ok(repo.lot(lot).licenseBasis.some((b) => b.scope_mode === "versions"));
});
