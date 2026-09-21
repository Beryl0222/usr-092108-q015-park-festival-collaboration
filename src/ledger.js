// 事件折叠：把不可变的领域事件流折叠成履约当前状态。
// 事件被接收后不原地改写，业务更正（取消、收窄、冻结、处置）一律以后继事件表达。

export function createState() {
  return {
    capacity: new Map(), // kind -> { total, used }，900克手工与标准各自计量
    licenses: new Map(), // 授权 id -> { elements, scopes: [{ effective_at, versions }] }
    designs: new Map(), // 设计 id -> Map(版次 -> { license_id, elements, cleared_at })
    recipes: new Map(), // 口味 -> { allergens }
    specs: new Map(), // 礼盒规格 id -> { kind, components, flavors, label_version }
    stock: new Map(), // 规格 id -> { released, allocated, reserved }
    foodBatches: new Map(), // 食品批次 id -> { flavor, kind, qty, remaining, status, expires_at, design_id, design_version }
    componentLots: new Map(), // 部件批次 id -> { component_type, qty, remaining, status, design_id, design_version }
    bundleBatches: new Map(), // 装配批次 id -> { spec_id, qty, allocated, food_batches, component_lots, label_version, status, held_reason }
    quotas: new Map(), // "渠道::规格" -> { channel, spec_id, allocated, reserved }
    orders: new Map(), // 订单 id -> { channel, spec_id, qty, status, pickup, method, bundle_batch, food_batches, component_lots, settled, remedy }
    settlements: new Map(), // 结算单 id -> { channel, period, order_ids, fulfilled_qty }
    versions: new Map(), // "聚合类型/聚合id" -> 已接收事件数，供命令层生成 version
  };
}

export const quotaKey = (channel, specId) => `${channel}::${specId}`;

export function mustGet(map, id, what) {
  const value = map.get(id);
  if (!value) throw new Error(`找不到${what}：${id}`);
  return value;
}

const beforeOrAt = (a, b) => Date.parse(a) <= Date.parse(b);

// 授权在某个时刻生效的版次范围；收窄只追加新 scope，历史 scope 保留作为已产批次的依据。
export function licenseScopeAt(license, when) {
  const hit = license.scopes.filter((s) => beforeOrAt(s.effective_at, when)).at(-1);
  return hit ? hit.versions : [];
}

function releaseHold(state, order) {
  const quota = state.quotas.get(quotaKey(order.channel, order.spec_id));
  if (quota) quota.reserved -= order.qty;
  const stock = state.stock.get(order.spec_id);
  if (stock) stock.reserved -= order.qty;
}

export function applyEvent(state, event) {
  const key = `${event.aggregate_type}/${event.aggregate_id}`;
  state.versions.set(key, (state.versions.get(key) ?? 0) + 1);
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "CAPACITY_DEFINED":
      state.capacity.set(p.kind, { total: p.total, used: 0 });
      break;
    case "LICENSE_GRANTED":
      state.licenses.set(event.aggregate_id, {
        elements: p.elements ?? [],
        scopes: [{ effective_at: p.valid_from ?? event.occurred_at, versions: [...(p.design_versions ?? [])] }],
      });
      break;
    case "LICENSE_NARROWED": {
      const license = mustGet(state.licenses, event.aggregate_id, "授权");
      const effectiveAt = p.effective_at ?? event.occurred_at;
      const removed = new Set(p.removed_versions ?? []);
      const remaining = licenseScopeAt(license, effectiveAt).filter((v) => !removed.has(v));
      license.scopes.push({ effective_at: effectiveAt, versions: remaining });
      break;
    }
    case "DESIGN_CLEARED": {
      const versions = state.designs.get(event.aggregate_id) ?? new Map();
      versions.set(p.version, { license_id: p.license_id, elements: p.elements ?? [], cleared_at: event.occurred_at });
      state.designs.set(event.aggregate_id, versions);
      break;
    }
    case "RECIPE_REGISTERED":
      state.recipes.set(p.flavor, { allergens: p.allergens ?? [] });
      break;
    case "BUNDLE_SPEC_DEFINED":
      state.specs.set(event.aggregate_id, {
        kind: p.kind,
        components: p.components ?? [],
        flavors: p.flavors ?? [],
        label_version: null,
      });
      state.stock.set(event.aggregate_id, { released: 0, allocated: 0, reserved: 0 });
      break;
    case "LABEL_PUBLISHED":
      mustGet(state.specs, event.aggregate_id, "礼盒规格").label_version = p.label_version;
      break;
    case "FOOD_BATCH_PRODUCED": {
      state.foodBatches.set(event.aggregate_id, {
        flavor: p.flavor,
        kind: p.kind,
        qty: p.qty,
        remaining: p.qty,
        status: "ok",
        expires_at: p.expires_at,
        design_id: p.design_id ?? null,
        design_version: p.design_version ?? null,
      });
      const cap = state.capacity.get(p.kind);
      if (cap) cap.used += p.qty;
      break;
    }
    case "FOOD_BATCH_QUARANTINED":
      mustGet(state.foodBatches, event.aggregate_id, "食品批次").status = "quarantined";
      break;
    case "FOOD_BATCH_DISPOSED":
      mustGet(state.foodBatches, event.aggregate_id, "食品批次").status = "disposed";
      break;
    case "COMPONENT_ACCEPTED":
      state.componentLots.set(event.aggregate_id, {
        component_type: p.component_type,
        qty: p.qty,
        remaining: p.qty,
        status: "ok",
        design_id: p.design_id ?? null,
        design_version: p.design_version ?? null,
      });
      break;
    case "BUNDLE_ASSEMBLED":
      state.bundleBatches.set(event.aggregate_id, {
        spec_id: p.spec_id,
        qty: p.qty,
        allocated: 0,
        food_batches: [...p.food_batches],
        component_lots: [...p.component_lots],
        label_version: p.label_version,
        status: "assembled",
        held_reason: null,
      });
      for (const [id, n] of Object.entries(p.consumed.food)) mustGet(state.foodBatches, id, "食品批次").remaining -= n;
      for (const [id, n] of Object.entries(p.consumed.components)) mustGet(state.componentLots, id, "部件批次").remaining -= n;
      break;
    case "BUNDLE_RELEASED": {
      const batch = mustGet(state.bundleBatches, event.aggregate_id, "装配批次");
      batch.status = "released";
      const stock = state.stock.get(batch.spec_id);
      if (stock) stock.released += batch.qty;
      break;
    }
    case "BUNDLE_HELD": {
      const batch = mustGet(state.bundleBatches, event.aggregate_id, "装配批次");
      batch.status = "held";
      batch.held_reason = p.reason ?? null;
      break;
    }
    case "QUOTA_ALLOCATED": {
      const quota = state.quotas.get(event.aggregate_id) ?? { channel: p.channel, spec_id: p.spec_id, allocated: 0, reserved: 0, fulfilled: 0 };
      quota.allocated += p.qty;
      state.quotas.set(event.aggregate_id, quota);
      break;
    }
    case "ORDER_RESERVED": {
      state.orders.set(event.aggregate_id, {
        channel: p.channel,
        spec_id: p.spec_id,
        qty: p.qty,
        status: "reserved",
        pickup: p.pickup ?? null,
        method: null,
        bundle_batch: null,
        food_batches: [],
        component_lots: [],
        settled: false,
        remedy: null,
      });
      const quota = state.quotas.get(quotaKey(p.channel, p.spec_id));
      if (quota) quota.reserved += p.qty;
      const stock = state.stock.get(p.spec_id);
      if (stock) stock.reserved += p.qty;
      break;
    }
    case "RESERVATION_EXPIRED":
    case "ORDER_CANCELLED": {
      const order = mustGet(state.orders, event.aggregate_id, "订单");
      if (order.status !== "reserved") break; // 安全释放：只释放一次，重复事件不再扣减
      releaseHold(state, order);
      order.status = event.event_type === "ORDER_CANCELLED" ? "cancelled" : "expired";
      break;
    }
    case "ORDER_FULFILLED": {
      const order = mustGet(state.orders, event.aggregate_id, "订单");
      releaseHold(state, order);
      // 预留转为实销：配额不回流，继续被已履约部分占用
      const quota = state.quotas.get(quotaKey(order.channel, order.spec_id));
      if (quota) quota.fulfilled += order.qty;
      const stock = state.stock.get(order.spec_id);
      if (stock) stock.allocated += order.qty;
      order.status = "fulfilled";
      order.method = p.method;
      order.bundle_batch = p.bundle_batch;
      order.food_batches = [...p.food_batches];
      order.component_lots = [...p.component_lots];
      order.fulfilled_at = event.occurred_at;
      const batch = state.bundleBatches.get(p.bundle_batch);
      if (batch) batch.allocated += order.qty;
      break;
    }
    case "REMEDY_SHIPPED": {
      const order = mustGet(state.orders, event.aggregate_id, "订单");
      order.remedy = {
        shipped_at: event.occurred_at,
        food_batches: [...p.food_batches],
        component_lots: [...p.component_lots],
        completed: false,
      };
      break;
    }
    case "REMEDY_COMPLETED":
      mustGet(state.orders, event.aggregate_id, "订单").remedy.completed = true;
      break;
    case "SETTLEMENT_RECORDED":
      state.settlements.set(event.aggregate_id, {
        channel: p.channel,
        period: p.period,
        order_ids: [...p.order_ids],
        fulfilled_qty: p.fulfilled_qty,
      });
      for (const id of p.order_ids) mustGet(state.orders, id, "订单").settled = true;
      break;
    default:
      throw new Error(`未知事件类型：${event.event_type}`);
  }
  return state;
}
