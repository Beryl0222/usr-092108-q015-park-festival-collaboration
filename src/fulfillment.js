// 履约命令：每条命令先校验业务不变量，再产出后继事件（不直接改状态）。
// 调用方拿到事件后交给 applyEvent 折叠；校验失败抛中文错误，不产生任何事件。

import { licenseScopeAt, mustGet, quotaKey } from "./ledger.js";

function nextEvent(state, { event_type, aggregate_type, aggregate_id, occurred_at, summary, payload }) {
  const key = `${aggregate_type}/${aggregate_id}`;
  const version = (state.versions.get(key) ?? 0) + 1;
  return {
    event_id: `${aggregate_id}-e${version}`,
    event_type,
    aggregate_type,
    aggregate_id,
    occurred_at: occurred_at ?? new Date().toISOString(),
    version,
    summary,
    payload,
  };
}

// 授权收窄只约束尚未生产的版次：生产类命令按生产时刻的 scope 校验，
// 已产批次当时的依据留在事件里，收窄不影响其后续装配与放行。
function assertLicense(state, designId, designVersion, at) {
  if (!designId) return;
  const version = state.designs.get(designId)?.get(designVersion);
  if (!version) throw new Error(`设计版次未放行：${designId} ${designVersion}`);
  const license = state.licenses.get(version.license_id);
  if (!license || !licenseScopeAt(license, at).includes(designVersion)) {
    throw new Error(`授权在 ${at} 不覆盖版次 ${designVersion}`);
  }
}

export function defineCapacity(state, { kind, total, at }) {
  return nextEvent(state, {
    event_type: "CAPACITY_DEFINED",
    aggregate_type: "capacity_pool",
    aggregate_id: kind,
    occurred_at: at,
    summary: `登记产能 ${kind}：${total}`,
    payload: { kind, total },
  });
}

export function grantLicense(state, { license_id, elements, design_versions, valid_from, at }) {
  return nextEvent(state, {
    event_type: "LICENSE_GRANTED",
    aggregate_type: "cultural_license",
    aggregate_id: license_id,
    occurred_at: at,
    summary: `授予文化元素授权 ${license_id}，覆盖版次 ${design_versions.join("、")}`,
    payload: { elements, design_versions, valid_from },
  });
}

export function narrowLicense(state, { license_id, removed_versions, effective_at, at }) {
  const license = mustGet(state.licenses, license_id, "授权");
  const current = licenseScopeAt(license, effective_at ?? at);
  const outside = removed_versions.filter((v) => !current.includes(v));
  if (outside.length) throw new Error(`版次不在当前授权范围：${outside.join("、")}`);
  return nextEvent(state, {
    event_type: "LICENSE_NARROWED",
    aggregate_type: "cultural_license",
    aggregate_id: license_id,
    occurred_at: at,
    summary: `收窄授权 ${license_id}，移除版次 ${removed_versions.join("、")}（仅约束尚未生产的版本）`,
    payload: { removed_versions, effective_at },
  });
}

export function clearDesign(state, { design_id, version, license_id, elements, at }) {
  mustGet(state.licenses, license_id, "授权");
  return nextEvent(state, {
    event_type: "DESIGN_CLEARED",
    aggregate_type: "collaboration_design",
    aggregate_id: design_id,
    occurred_at: at,
    summary: `放行设计 ${design_id} 版次 ${version}`,
    payload: { version, license_id, elements },
  });
}

export function registerRecipe(state, { flavor, allergens, at }) {
  return nextEvent(state, {
    event_type: "RECIPE_REGISTERED",
    aggregate_type: "recipe",
    aggregate_id: `recipe-${flavor}`,
    occurred_at: at,
    summary: `登记口味 ${flavor} 配方，过敏原：${allergens.join("、") || "无"}`,
    payload: { flavor, allergens },
  });
}

export function defineBundleSpec(state, { spec_id, kind, components, flavors, at }) {
  for (const f of flavors) {
    if (!state.recipes.has(f.flavor)) throw new Error(`口味未登记配方：${f.flavor}`);
  }
  return nextEvent(state, {
    event_type: "BUNDLE_SPEC_DEFINED",
    aggregate_type: "bundle_spec",
    aggregate_id: spec_id,
    occurred_at: at,
    summary: `定义礼盒规格 ${spec_id}（${kind}）`,
    payload: { kind, components, flavors },
  });
}

export function publishLabel(state, { spec_id, label_version, at }) {
  mustGet(state.specs, spec_id, "礼盒规格");
  return nextEvent(state, {
    event_type: "LABEL_PUBLISHED",
    aggregate_type: "bundle_spec",
    aggregate_id: spec_id,
    occurred_at: at,
    summary: `发布规格 ${spec_id} 当前标签版次 ${label_version}`,
    payload: { spec_id, label_version },
  });
}

export function produceFoodBatch(state, { batch_id, flavor, kind, qty, expires_at, design_id, design_version, at }) {
  if (!state.recipes.has(flavor)) throw new Error(`口味未登记配方：${flavor}`);
  const cap = state.capacity.get(kind);
  if (!cap) throw new Error(`未登记产能类型：${kind}`);
  if (cap.used + qty > cap.total) throw new Error(`${kind} 产能不足，剩余 ${cap.total - cap.used}`);
  assertLicense(state, design_id, design_version, at);
  return nextEvent(state, {
    event_type: "FOOD_BATCH_PRODUCED",
    aggregate_type: "food_batch",
    aggregate_id: batch_id,
    occurred_at: at,
    summary: `生产食品批次 ${batch_id}（${flavor}，${kind}，${qty} 件）`,
    payload: { flavor, kind, qty, expires_at, design_id, design_version },
  });
}

export function acceptComponent(state, { lot_id, component_type, qty, design_id, design_version, at }) {
  assertLicense(state, design_id, design_version, at);
  return nextEvent(state, {
    event_type: "COMPONENT_ACCEPTED",
    aggregate_type: "component_lot",
    aggregate_id: lot_id,
    occurred_at: at,
    summary: `验收部件批次 ${lot_id}（${component_type}，${qty} 件）`,
    payload: { component_type, qty, design_id, design_version },
  });
}

// 组合装配：食品批次须可用手工/标准类型与规格一致，部件须齐备，消耗量写入事件供折叠扣减。
export function assembleBundle(state, { bundle_batch_id, spec_id, qty, food_batches, component_lots, at }) {
  const spec = mustGet(state.specs, spec_id, "礼盒规格");
  if (!spec.label_version) throw new Error(`规格 ${spec_id} 尚未发布标签`);

  const needFood = new Map(spec.flavors.map((f) => [f.flavor, f.qty_per * qty]));
  const consumedFood = {};
  for (const id of food_batches) {
    const batch = mustGet(state.foodBatches, id, "食品批次");
    if (batch.status !== "ok") throw new Error(`食品批次 ${id} 状态为 ${batch.status}，不可装配`);
    if (batch.kind !== spec.kind) throw new Error(`食品批次 ${id} 产能类型 ${batch.kind} 与规格 ${spec.kind} 不符`);
    if (!needFood.has(batch.flavor)) throw new Error(`食品批次 ${id} 的口味 ${batch.flavor} 不在规格 ${spec_id} 内`);
    const need = needFood.get(batch.flavor);
    if (need <= 0) throw new Error(`食品批次 ${id} 超出配方需求`);
    const take = Math.min(batch.remaining, need);
    if (take <= 0) throw new Error(`食品批次 ${id} 余量不足`);
    consumedFood[id] = take;
    needFood.set(batch.flavor, need - take);
  }
  const shortFood = [...needFood.entries()].filter(([, n]) => n > 0);
  if (shortFood.length) throw new Error(`食品数量不足：${shortFood.map(([f, n]) => `${f} 缺 ${n}`).join("，")}`);

  const needComp = new Map(spec.components.map((c) => [c.component_type, c.qty_per * qty]));
  const consumedComp = {};
  for (const id of component_lots) {
    const lot = mustGet(state.componentLots, id, "部件批次");
    if (lot.status !== "ok") throw new Error(`部件批次 ${id} 状态为 ${lot.status}，不可装配`);
    if (!needComp.has(lot.component_type)) throw new Error(`部件批次 ${id} 类型 ${lot.component_type} 不在规格 ${spec_id} 内`);
    const need = needComp.get(lot.component_type);
    if (need <= 0) throw new Error(`部件批次 ${id} 超出配方需求`);
    const take = Math.min(lot.remaining, need);
    if (take <= 0) throw new Error(`部件批次 ${id} 余量不足`);
    consumedComp[id] = take;
    needComp.set(lot.component_type, need - take);
  }
  const shortComp = [...needComp.entries()].filter(([, n]) => n > 0);
  if (shortComp.length) throw new Error(`部件数量不足：${shortComp.map(([t, n]) => `${t} 缺 ${n}`).join("，")}`);

  return nextEvent(state, {
    event_type: "BUNDLE_ASSEMBLED",
    aggregate_type: "bundle_batch",
    aggregate_id: bundle_batch_id,
    occurred_at: at,
    summary: `装配批次 ${bundle_batch_id}（规格 ${spec_id}，${qty} 盒，标签 ${spec.label_version}）`,
    payload: {
      spec_id,
      qty,
      food_batches,
      component_lots,
      label_version: spec.label_version,
      consumed: { food: consumedFood, components: consumedComp },
    },
  });
}

// 放行门槛：全部部件与食品批次可用，且贴的是当前标签版次，缺一不可。
export function releaseBundle(state, { bundle_batch_id, at }) {
  const batch = mustGet(state.bundleBatches, bundle_batch_id, "装配批次");
  if (batch.status !== "assembled") throw new Error(`装配批次状态为 ${batch.status}，不可放行`);
  const spec = state.specs.get(batch.spec_id);
  if (batch.label_version !== spec.label_version) {
    throw new Error(`标签版次 ${batch.label_version} 不是当前版次 ${spec.label_version}，需换贴后放行`);
  }
  for (const id of batch.food_batches) {
    const food = state.foodBatches.get(id);
    if (food.status !== "ok") throw new Error(`食品批次 ${id} 状态为 ${food.status}，不可放行`);
  }
  for (const id of batch.component_lots) {
    const lot = state.componentLots.get(id);
    if (lot.status !== "ok") throw new Error(`部件批次 ${id} 状态为 ${lot.status}，不可放行`);
  }
  return nextEvent(state, {
    event_type: "BUNDLE_RELEASED",
    aggregate_type: "bundle_batch",
    aggregate_id: bundle_batch_id,
    occurred_at: at,
    summary: `放行装配批次 ${bundle_batch_id}（${batch.qty} 盒）`,
    payload: { spec_id: batch.spec_id, qty: batch.qty, label_version: batch.label_version },
  });
}

export function allocateQuota(state, { channel, spec_id, qty, at }) {
  mustGet(state.specs, spec_id, "礼盒规格");
  return nextEvent(state, {
    event_type: "QUOTA_ALLOCATED",
    aggregate_type: "channel_quota",
    aggregate_id: quotaKey(channel, spec_id),
    occurred_at: at,
    summary: `为渠道 ${channel} 分配规格 ${spec_id} 配额 ${qty}`,
    payload: { channel, spec_id, qty },
  });
}

// 门店真实可售：本渠道配额余量（扣除预留与已履约）与全网已放行余量取小，不看全网虚数。
export function availableForChannel(state, channel, spec_id) {
  const quota = state.quotas.get(quotaKey(channel, spec_id));
  const quotaAvail = quota ? quota.allocated - quota.reserved - quota.fulfilled : 0;
  const stock = state.stock.get(spec_id) ?? { released: 0, allocated: 0, reserved: 0 };
  const stockAvail = stock.released - stock.allocated - stock.reserved;
  return Math.max(0, Math.min(quotaAvail, stockAvail));
}

export function reserveOrder(state, { order_id, channel, spec_id, qty, pickup, at }) {
  if (state.orders.has(order_id)) throw new Error(`订单已存在：${order_id}`);
  mustGet(state.specs, spec_id, "礼盒规格");
  if (availableForChannel(state, channel, spec_id) < qty) {
    throw new Error(`渠道 ${channel} 可售不足，当前可售 ${availableForChannel(state, channel, spec_id)}`);
  }
  return nextEvent(state, {
    event_type: "ORDER_RESERVED",
    aggregate_type: "customer_order",
    aggregate_id: order_id,
    occurred_at: at,
    summary: `预留订单 ${order_id}（渠道 ${channel}，规格 ${spec_id}，${qty} 盒）`,
    payload: { channel, spec_id, qty, pickup },
  });
}

// 迟到支付按过期处理：释放配额；重复调用安全返回 null，不会二次释放。
export function expireReservation(state, { order_id, at }) {
  const order = mustGet(state.orders, order_id, "订单");
  if (order.status !== "reserved") return null;
  return nextEvent(state, {
    event_type: "RESERVATION_EXPIRED",
    aggregate_type: "customer_order",
    aggregate_id: order_id,
    occurred_at: at,
    summary: `订单 ${order_id} 支付超时，预留到期并释放配额`,
    payload: { channel: order.channel, spec_id: order.spec_id, qty: order.qty },
  });
}

export function cancelOrder(state, { order_id, at }) {
  const order = mustGet(state.orders, order_id, "订单");
  if (order.status !== "reserved") return null;
  return nextEvent(state, {
    event_type: "ORDER_CANCELLED",
    aggregate_type: "customer_order",
    aggregate_id: order_id,
    occurred_at: at,
    summary: `订单 ${order_id} 取消，释放配额`,
    payload: { channel: order.channel, spec_id: order.spec_id, qty: order.qty },
  });
}

export function fulfillOrder(state, { order_id, method, at }) {
  const order = mustGet(state.orders, order_id, "订单");
  if (order.status !== "reserved") throw new Error(`订单状态为 ${order.status}，不可履约`);
  const batchId = [...state.bundleBatches.entries()]
    .filter(([, b]) => b.spec_id === order.spec_id && b.status === "released" && b.qty - b.allocated >= order.qty)
    .map(([id]) => id)[0];
  if (!batchId) throw new Error(`规格 ${order.spec_id} 无足够已放行批次`);
  const batch = state.bundleBatches.get(batchId);
  return nextEvent(state, {
    event_type: "ORDER_FULFILLED",
    aggregate_type: "customer_order",
    aggregate_id: order_id,
    occurred_at: at,
    summary: `履约订单 ${order_id}（${method === "pickup" ? "门店自提" : "快递"}，批次 ${batchId}）`,
    payload: {
      method,
      bundle_batch: batchId,
      food_batches: batch.food_batches,
      component_lots: batch.component_lots,
    },
  });
}

// 口味检验异常：只隔离该口味的食品批次与用到它们的在库组合，定位相关订单；
// 香囊、茶饮等部件批次一律不动。已放行流入市场的组合通过 traceOrder 召回，不原地冻结。
export function quarantineFlavor(state, { flavor, reason, at }) {
  const events = [];
  const hitIds = [...state.foodBatches.entries()]
    .filter(([, b]) => b.flavor === flavor && b.status === "ok")
    .map(([id]) => id);
  const hit = new Set(hitIds);
  for (const id of hitIds) {
    events.push(
      nextEvent(state, {
        event_type: "FOOD_BATCH_QUARANTINED",
        aggregate_type: "food_batch",
        aggregate_id: id,
        occurred_at: at,
        summary: `检验异常，隔离食品批次 ${id}（${flavor}）`,
        payload: { flavor, reason },
      }),
    );
  }
  for (const [id, batch] of state.bundleBatches) {
    if (batch.status === "assembled" && batch.food_batches.some((x) => hit.has(x))) {
      events.push(
        nextEvent(state, {
          event_type: "BUNDLE_HELD",
          aggregate_type: "bundle_batch",
          aggregate_id: id,
          occurred_at: at,
          summary: `组合 ${id} 含异常口味 ${flavor}，冻结待查`,
          payload: { flavor, reason },
        }),
      );
    }
  }
  return events;
}

export function locateFlavorImpact(state, flavor) {
  const food = [...state.foodBatches.entries()].filter(([, b]) => b.flavor === flavor).map(([id]) => id);
  const foodSet = new Set(food);
  const bundles = [...state.bundleBatches.entries()].filter(([, b]) => b.food_batches.some((x) => foodSet.has(x)));
  const bundleIds = bundles.map(([id]) => id);
  const bundleSet = new Set(bundleIds);
  const specSet = new Set(bundles.map(([, b]) => b.spec_id));
  const orders = [...state.orders.entries()]
    .filter(([, o]) => (o.bundle_batch && bundleSet.has(o.bundle_batch)) || (o.status === "reserved" && specSet.has(o.spec_id)))
    .map(([id]) => id);
  return { food_batches: food, bundle_batches: bundleIds, orders };
}

// 临期处置：只动到期窗口内仍可用的食品批次。
export function disposeNearExpiry(state, { now, within_days }) {
  const limit = Date.parse(now) + within_days * 24 * 60 * 60 * 1000;
  return [...state.foodBatches.entries()]
    .filter(([, b]) => b.status === "ok" && Date.parse(b.expires_at) <= limit)
    .map(([id, b]) =>
      nextEvent(state, {
        event_type: "FOOD_BATCH_DISPOSED",
        aggregate_type: "food_batch",
        aggregate_id: id,
        occurred_at: now,
        summary: `批次 ${id} 临近保质期（${b.expires_at}），转入处置`,
        payload: { flavor: b.flavor, reason: "near_expiry", expires_at: b.expires_at },
      }),
    );
}

// 破损补寄：沿用原订单履约时锁定的食品批次与文创部件，全程可追。
export function shipRemedy(state, { order_id, at }) {
  const order = mustGet(state.orders, order_id, "订单");
  if (order.status !== "fulfilled") throw new Error(`订单状态为 ${order.status}，仅已履约订单可补寄`);
  if (order.remedy && !order.remedy.completed) throw new Error(`订单 ${order_id} 已有进行中的补寄`);
  return nextEvent(state, {
    event_type: "REMEDY_SHIPPED",
    aggregate_type: "customer_order",
    aggregate_id: order_id,
    occurred_at: at,
    summary: `订单 ${order_id} 破损补寄，沿用批次 ${order.bundle_batch} 的追溯信息`,
    payload: { bundle_batch: order.bundle_batch, food_batches: order.food_batches, component_lots: order.component_lots },
  });
}

export function completeRemedy(state, { order_id, at }) {
  const order = mustGet(state.orders, order_id, "订单");
  if (!order.remedy || order.remedy.completed) throw new Error(`订单 ${order_id} 无待完成的补寄`);
  return nextEvent(state, {
    event_type: "REMEDY_COMPLETED",
    aggregate_type: "customer_order",
    aggregate_id: order_id,
    occurred_at: at,
    summary: `订单 ${order_id} 补寄完成`,
    payload: {},
  });
}

// 合作方按实际履约清算：只计已履约且未结算的订单，取消与过期不计。
export function settleChannel(state, { settlement_id, channel, period, at }) {
  const orderIds = [...state.orders.entries()]
    .filter(([, o]) => o.channel === channel && o.status === "fulfilled" && !o.settled)
    .map(([id]) => id);
  if (orderIds.length === 0) throw new Error(`渠道 ${channel} 无待结算履约单`);
  const qty = orderIds.reduce((n, id) => n + state.orders.get(id).qty, 0);
  return nextEvent(state, {
    event_type: "SETTLEMENT_RECORDED",
    aggregate_type: "partner_settlement",
    aggregate_id: settlement_id,
    occurred_at: at,
    summary: `渠道 ${channel} ${period} 结算：${orderIds.length} 单共 ${qty} 盒`,
    payload: { channel, period, order_ids: orderIds, fulfilled_qty: qty },
  });
}

// 召回/补寄追溯：任一订单追到具体食品批次与文创部件。
export function traceOrder(state, order_id) {
  const order = mustGet(state.orders, order_id, "订单");
  return {
    order_id,
    status: order.status,
    spec_id: order.spec_id,
    bundle_batch: order.bundle_batch,
    food_batches: [...order.food_batches],
    component_lots: [...order.component_lots],
  };
}

// 消费者确认：取货时间、口味与过敏原（由配方汇总去重）。
export function describeOrderForCustomer(state, order_id) {
  const order = mustGet(state.orders, order_id, "订单");
  const spec = mustGet(state.specs, order.spec_id, "礼盒规格");
  const flavors = spec.flavors.map((f) => f.flavor);
  const allergens = [...new Set(flavors.flatMap((f) => state.recipes.get(f)?.allergens ?? []))];
  return { order_id, status: order.status, pickup: order.pickup, flavors, allergens };
}
