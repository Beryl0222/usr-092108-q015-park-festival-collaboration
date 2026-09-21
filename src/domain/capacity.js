import { Codes, fail } from "./errors.js";

// 产能按生产模式分账：900 克手工产品与标准礼盒互不挤占。
// 同一模式内可按日期/工厂声明多条产能；消费按模式汇总扣减。

export function reduceCapacity(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "CAPACITY_DECLARED": {
      const buckets = new Map(state.buckets);
      const key = capacityKey(d.production_mode, d.factory_id, d.production_date);
      const prev = buckets.get(key);
      buckets.set(key, {
        productionMode: d.production_mode,
        factoryId: d.factory_id,
        productionDate: d.production_date,
        units: d.units,
        consumed: prev?.consumed ?? 0
      });
      return { ...state, buckets };
    }
    case "CAPACITY_CONSUMED": {
      const buckets = new Map(state.buckets);
      const key = capacityKey(d.production_mode, d.factory_id, d.production_date);
      const prev = buckets.get(key);
      if (!prev) fail(Codes.CAPACITY_EXCEEDED, `未声明产能：${key}`);
      const consumed = prev.consumed + d.units;
      if (consumed > prev.units) {
        fail(Codes.CAPACITY_EXCEEDED, `${key} 产能不足：剩余 ${prev.units - prev.consumed}，申请 ${d.units}`, {
          remaining: prev.units - prev.consumed,
          requested: d.units
        });
      }
      buckets.set(key, { ...prev, consumed });
      return { ...state, buckets };
    }
    default:
      return state;
  }
}

export function capacityKey(productionMode, factoryId, productionDate) {
  return `${productionMode}|${factoryId}|${productionDate}`;
}

export function remainingByMode(state, productionMode) {
  let total = 0;
  for (const b of state.buckets.values()) {
    if (b.productionMode === productionMode) total += b.units - b.consumed;
  }
  return total;
}
