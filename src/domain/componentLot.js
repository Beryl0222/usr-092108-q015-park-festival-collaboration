import { Codes, fail } from "./errors.js";

// 统一的部件批次：食品（月饼、节令茶饮）与非食品（花丝香囊、古建纹样件、祝福卡）
// 都落在 component_lot。数量以“可装配份数”计。
//
// 文化类非食品部件在入库时固化 license_basis（当时授权快照）；
// 之后授权收窄不回溯已生产批次。食品部件固化配方版次、口味、过敏原与标签版次。

export function reduceLot(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "FOOD_BATCH_PRODUCED":
      return {
        lotId: d.lot_id,
        kind: "food",
        componentId: d.component_id,
        componentName: d.component_name,
        factoryId: d.factory_id,
        producedAt: d.produced_at,
        recipeId: d.recipe_id,
        recipeVersion: d.recipe_version,
        flavorId: d.flavor_id,
        allergens: new Set(d.allergens ?? []),
        productionMode: d.production_mode,
        labelCode: d.label_code,
        bestBefore: d.best_before,
        qtyReceived: d.units,
        qtyAccepted: 0,
        qtyAllocated: 0,
        qtyQuarantined: 0,
        qtyScrapped: 0,
        qtyRecalled: 0,
        allocations: [],
        status: "produced",
        holds: []
      };
    case "NONFOOD_COMPONENT_RECEIVED":
      return {
        lotId: d.lot_id,
        kind: "nonfood",
        componentId: d.component_id,
        componentName: d.component_name,
        supplierPartnerId: d.supplier_partner_id ?? null,
        receivedAt: d.received_at,
        designVersionId: d.design_version_id ?? null,
        // 入库瞬间的授权依据，永久保存
        licenseBasis: (d.license_basis ?? []).map((b) => ({ ...b })),
        customization: d.customization ?? null, // 祝福卡定制规格
        qtyReceived: d.units,
        qtyAccepted: 0,
        qtyAllocated: 0,
        qtyQuarantined: 0,
        qtyScrapped: 0,
        qtyRecalled: 0,
        allocations: [],
        status: "received",
        holds: []
      };
    case "LOT_LABEL_REFRESHED":
      return { ...state, labelCode: d.label_code, relabeledAt: event.occurred_at };
    case "COMPONENT_ACCEPTED":
      return { ...state, qtyAccepted: state.qtyReceived, status: "accepted" };
    case "COMPONENT_QUARANTINED":
      return {
        ...state,
        qtyQuarantined: state.qtyQuarantined + d.units,
        status: "quarantined",
        holds: [...state.holds, { at: event.occurred_at, units: d.units, reason: d.reason, reference: d.reference ?? null }]
      };
    case "COMPONENT_ALLOCATED": {
      const available = lotAvailable(state);
      if (d.units > available) {
        fail(Codes.INSUFFICIENT_COMPONENTS, `批次 ${state.lotId} 可用 ${available}，申请 ${d.units}`, {
          lot_id: state.lotId,
          available,
          requested: d.units
        });
      }
      return {
        ...state,
        qtyAllocated: state.qtyAllocated + d.units,
        allocations: [...state.allocations, { bundleBatchId: d.bundle_batch_id, units: d.units, purpose: d.purpose ?? "assembly", at: event.occurred_at }]
      };
    }
    case "COMPONENT_SCRAPPED":
      return { ...state, qtyScrapped: state.qtyScrapped + d.units, status: "scrapped", scrappedReason: d.reason };
    case "COMPONENT_RECALLED":
      return { ...state, qtyRecalled: state.qtyRecalled + (d.units ?? 0), status: "recalled" };
    default:
      return state;
  }
}

export function lotAvailable(lot) {
  return lot.qtyAccepted - lot.qtyAllocated - lot.qtyQuarantined - lot.qtyScrapped - lot.qtyRecalled;
}

export function lotUsable(lot, at) {
  if (!lot || lot.status !== "accepted") return { ok: false, reason: "lot_not_usable", status: lot?.status };
  if (lot.kind === "food" && lot.bestBefore && Date.parse(at) > Date.parse(lot.bestBefore)) {
    return { ok: false, reason: "lot_expired", best_before: lot.bestBefore };
  }
  return { ok: true };
}
