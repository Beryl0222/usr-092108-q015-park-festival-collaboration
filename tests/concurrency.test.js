import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld } from "./helpers/fixture.js";

const sellStart = "2026-09-11T10:00:00+08:00";
const deadline = "2026-09-12T22:00:00+08:00";

test("乐观并发：陈旧期望版本被拒，多流事务整体回滚", () => {
  const { app, repo, ids } = buildWorld();
  const quotaStream = `channel_quota:${ids.quotaStore1}`;
  const staleVersion = repo.quotaVersion(ids.quotaStore1); // 当前 = 3（开放+两铺货）

  // 先发生一笔真实预售，使配额流变到 4
  app.reserveOrder({ order_id: "ord-first", quota_id: ids.quotaStore1, units: 1, fulfillment_type: "pickup", expires_at: deadline, at: sellStart });
  assert.equal(repo.quotaVersion(ids.quotaStore1), staleVersion + 1);

  // 用陈旧版本 3 提交“保留 + 新订单”两流事务：必须被拒
  assert.throws(
    () => app.store.commit([
      { stream: quotaStream, expectedVersion: staleVersion, events: [{ event_type: "QUOTA_RESERVED", aggregate_id: ids.quotaStore1, summary: "陈旧事务", data: { quota_id: ids.quotaStore1, reservation_id: "rsv-stale", order_id: "ord-stale", units: 1 } }] },
      { stream: "customer_order:ord-stale", expectedVersion: 0, events: [{ event_type: "ORDER_RESERVED", aggregate_id: "ord-stale", summary: "陈旧事务", data: { order_id: "ord-stale", channel_id: "ch-offline", store_id: "S1", quota_id: ids.quotaStore1, reservation_id: "rsv-stale", bundle_id: ids.bundleGift, units: 1, fulfillment_type: "pickup" } }] }
    ], () => sellStart),
    (err) => err.code === "CONCURRENT_WRITE"
  );

  // 回滚要彻底：配额流版本未增加，孤立订单流不存在
  assert.equal(repo.quotaVersion(ids.quotaStore1), staleVersion + 1);
  assert.equal(repo.orderVersion("ord-stale"), 0);
});

test("事件只追加：业务更正以后继事件表达，历史事件不被改写", () => {
  const { app, ids } = buildWorld();
  const before = app.store.loadStream(`component_lot:${ids.lotCard}`).map((e) => ({ ...e }));
  app.narrowLicense({ license_id: ids.licPavilion, design_version_ids: [], reason: "停止旧版", at: sellStart });
  const after = app.store.loadStream(`component_lot:${ids.lotCard}`);
  assert.equal(after.length, before.length);
  assert.deepEqual(after, before);
  // 授权变更产生在授权流自己的后继事件上
  const licenseEvents = app.store.loadStream(`cultural_license:${ids.licPavilion}`).map((e) => e.event_type);
  assert.deepEqual(licenseEvents, ["CULTURAL_ELEMENT_LICENSED", "LICENSE_SCOPE_NARROWED"]);
});
