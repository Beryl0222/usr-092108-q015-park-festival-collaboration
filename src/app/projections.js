import { sellableUnits } from "../domain/channelQuota.js";
import { fulfilledAt } from "../domain/customerOrder.js";
import { batchSellable } from "../domain/bundle.js";

// 只读投影。所有查询从事件回放得到的仓储状态派生，不写入任何业务状态。

// 门店/渠道看到的真实可售：渠道配额行上的 sellable - 保留，
// 绝不展示全网汇总虚数。
export function availabilityForChannel(repo, { channelId, storeId, bundleId }, at) {
  const rows = [];
  for (const q of repo.quotas) {
    if (q.channelId !== channelId) continue;
    if (storeId !== undefined && q.storeId !== storeId) continue;
    if (bundleId && q.bundleId !== bundleId) continue;
    rows.push({
      quota_id: q.quotaId,
      channel_id: q.channelId,
      store_id: q.storeId,
      bundle_id: q.bundleId,
      sellable: sellableUnits(q, at),
      supplies: q.supplies.map((s) => ({ supply_id: s.supplyId, bundle_batch_id: s.bundleBatchId, sellable: s.sellable, quarantined: s.quarantined }))
    });
  }
  return rows;
}

// 谱系索引：口味 ↔ 食品批次 ↔ 组合批次 ↔ 订单，全链路双向可追。
export function buildGenealogy(repo) {
  const lots = repo.lots;
  const batches = repo.bundleBatches;
  const orders = repo.orders;

  const flavorToLots = new Map();
  const lotToBatches = new Map();
  const batchToOrders = new Map();
  const orderToBatches = new Map();
  const lotToOrders = new Map();

  for (const lot of lots) {
    if (lot.kind !== "food") continue;
    if (!flavorToLots.has(lot.flavorId)) flavorToLots.set(lot.flavorId, new Set());
    flavorToLots.get(lot.flavorId).add(lot.lotId);
  }

  for (const batch of batches) {
    for (const lotId of batch.componentUsages.keys()) {
      if (!lotToBatches.has(lotId)) lotToBatches.set(lotId, new Set());
      lotToBatches.get(lotId).add(batch.bundleBatchId);
    }
  }

  const linkOrderBatch = (order, batchId) => {
    if (!batchId) return;
    if (!batchToOrders.has(batchId)) batchToOrders.set(batchId, new Set());
    batchToOrders.get(batchId).add(order.orderId);
    if (!orderToBatches.has(order.orderId)) orderToBatches.set(order.orderId, new Set());
    orderToBatches.get(order.orderId).add(batchId);
    const batch = batches.find((b) => b.bundleBatchId === batchId);
    if (batch) {
      for (const lotId of batch.componentUsages.keys()) {
        if (!lotToOrders.has(lotId)) lotToOrders.set(lotId, new Set());
        lotToOrders.get(lotId).add(order.orderId);
      }
    }
  };

  for (const order of orders) {
    if (order.bundleBatchId) linkOrderBatch(order, order.bundleBatchId);
    for (const s of order.shipments) linkOrderBatch(order, s.bundle_batch_id);
    for (const p of order.pickups) linkOrderBatch(order, p.bundle_batch_id);
    for (const r of order.replacements) linkOrderBatch(order, r.bundle_batch_id);
  }

  return {
    lots,
    batches,
    orders,
    flavorToLots,
    lotToBatches,
    batchToOrders,
    orderToBatches,
    lotToOrders,

    // 某口味检验异常：精确圈定含该口味的食品批次→组合批次→订单。
    impactOfFlavor(flavorId) {
      const lotIds = [...(flavorToLots.get(flavorId) ?? [])];
      const batchIds = uniq(lotIds.flatMap((id) => [...(lotToBatches.get(id) ?? [])]));
      const orderIds = uniq(batchIds.flatMap((id) => [...(batchToOrders.get(id) ?? [])]));
      return { flavor_id: flavorId, lot_ids: lotIds, bundle_batch_ids: batchIds, order_ids: orderIds };
    },

    // 从任一订单追到具体食品批次与文创部件（补寄/召回用）。
    traceOrder(orderId) {
      const batchIds = [...(orderToBatches.get(orderId) ?? [])];
      const foodLots = [];
      const nonfoodLots = [];
      for (const batchId of batchIds) {
        const batch = batches.find((b) => b.bundleBatchId === batchId);
        if (!batch) continue;
        for (const usage of batch.componentUsages.values()) {
          const lot = lots.find((l) => l.lotId === usage.lot_id);
          if (!lot) continue;
          (lot.kind === "food" ? foodLots : nonfoodLots).push({
            lot_id: lot.lotId,
            component_id: lot.componentId,
            component_name: lot.componentName,
            units: usage.units,
            batch_id: batchId,
            ...(lot.kind === "food"
              ? { flavor_id: lot.flavorId, recipe_version: lot.recipeVersion, allergens: [...lot.allergens], label_code: lot.labelCode, best_before: lot.bestBefore }
              : { design_version_id: lot.designVersionId, license_basis: lot.licenseBasis })
          });
        }
      }
      return { order_id: orderId, bundle_batch_ids: batchIds, food_lots: foodLots, nonfood_lots: nonfoodLots };
    },

    // 从食品批次反向追订单。
    ordersForLot(lotId) {
      return [...(lotToOrders.get(lotId) ?? [])];
    }
  };
}

// 临期视图：按截止时刻列出将到期/已到期的食品批次及其尚在何处（库存/组合批次/订单）。
export function expiringFoodLots(repo, genealogy, at, withinDays) {
  const cutoffMs = Date.parse(at) + withinDays * 86400000;
  const out = [];
  for (const lot of repo.lots) {
    if (lot.kind !== "food" || !lot.bestBefore) continue;
    if (Date.parse(lot.bestBefore) <= cutoffMs && lot.status !== "scrapped" && lot.status !== "recalled") {
      out.push({
        lot_id: lot.lotId,
        component_name: lot.componentName,
        best_before: lot.bestBefore,
        in_bundle_batches: [...(genealogy.lotToBatches.get(lot.lotId) ?? [])],
        order_ids: genealogy.ordersForLot(lot.lotId)
      });
    }
  }
  return out;
}

function uniq(arr) {
  return [...new Set(arr)];
}

export { fulfilledAt, batchSellable };
