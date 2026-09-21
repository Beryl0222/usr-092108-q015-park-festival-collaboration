import { Codes, fail } from "./errors.js";
import { labelIsCurrent } from "./labelCatalog.js";
import { lotAvailable, lotUsable } from "./componentLot.js";

// 组合定义（BOM）与组合批次（装配、放行、临期处置、召回）。
// 放行闸口：一个礼盒只有全部部件齐备、且每件食品挂载“当前批准”标签时才可放行。
// 非食品部件的授权依据在其入库时已固化（license_basis），放行只核验其存在与数量。

export function reduceBundleDefinition(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "BUNDLE_DEFINED":
      return {
        bundleId: d.bundle_id,
        name: d.name,
        collaborationId: d.collaboration_id,
        designVersionId: d.design_version_id,
        components: d.components.map((c) => ({ ...c })),
        flavorIds: new Set(d.flavor_ids ?? []),
        productionMode: d.production_mode // "handmade_900g" | "standard"
      };
    default:
      return state;
  }
}

export function reduceBundleBatch(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "BUNDLE_BATCH_ASSEMBLED":
      return {
        bundleBatchId: d.bundle_batch_id,
        bundleId: d.bundle_id,
        designVersionId: d.design_version_id,
        assembledAt: event.occurred_at,
        units: d.units,
        // lotId -> { lot_id, kind, units, label_code? }
        componentUsages: new Map(d.component_usages.map((u) => [u.lot_id, { ...u }])),
        unitsReleased: 0,
        unitsBlocked: 0,
        unitsDisposed: 0,
        unitsRecalled: 0,
        status: "assembled"
      };
    case "BUNDLE_RELEASED": {
      const remain = state.units - state.unitsReleased - state.unitsBlocked - state.unitsDisposed - state.unitsRecalled;
      if (d.units > remain) fail(Codes.INSUFFICIENT_COMPONENTS, `组合批次 ${state.bundleBatchId} 可放行 ${remain}，申请 ${d.units}`);
      return { ...state, unitsReleased: state.unitsReleased + d.units, status: "released", releasedAt: event.occurred_at };
    }
    case "BUNDLE_BATCH_BLOCKED":
      return { ...state, unitsBlocked: state.unitsBlocked + d.units, status: "blocked", blockedReason: d.reason };
    case "BUNDLE_BATCH_DISPOSED":
      return { ...state, unitsDisposed: state.unitsDisposed + d.units, status: "disposed", disposedAt: event.occurred_at, disposeReason: d.reason };
    case "BUNDLE_BATCH_RECALLED":
      return { ...state, unitsRecalled: state.unitsRecalled + d.units, status: "recalled", recalledAt: event.occurred_at };
    default:
      return state;
  }
}

// 装配前核验：BOM 每一部件都有足够可用份数。
export function verifyAssembly(definition, lotsById, units, at) {
  const missing = [];
  for (const required of definition.components) {
    const need = (required.units_per_bundle ?? 1) * units;
    const found = lotsByIdForComponent(lotsById, required.componentId);
    const have = found.reduce((sum, lot) => {
      const usable = lotUsable(lot, at);
      return sum + (usable.ok ? lotAvailable(lot) : 0);
    }, 0);
    if (have < need) missing.push({ component_id: required.component_id, need, have });
  }
  if (missing.length) fail(Codes.INSUFFICIENT_COMPONENTS, "部件不齐，不能装配", { missing });
  return true;
}

function lotsByIdForComponent(lotsById, componentId) {
  return [...lotsById.values()].filter((lot) => lot.componentId === componentId);
}

// 放行闸口。at：放行时刻（ISO 字符串），用于临期判定。
export function verifyRelease(definition, batch, lotsById, labelCatalog, at) {
  const problems = [];

  // 1) BOM 齐备性：装配用量覆盖每个必需部件。
  for (const required of definition.components) {
    const need = (required.units_per_bundle ?? 1) * batch.units;
    let have = 0;
    for (const usage of batch.componentUsages.values()) {
      const lot = lotsById.get(usage.lot_id);
      if (lot && lot.componentId === required.componentId) have += usage.units;
    }
    if (have < need) problems.push({ kind: "missing_component", component_id: required.component_id, need, have });
  }

  // 2) 食品件：批次可用、未临期、标签为当前批准版次。
  for (const usage of batch.componentUsages.values()) {
    const lot = lotsById.get(usage.lot_id);
    if (!lot) {
      problems.push({ kind: "unknown_lot", lot_id: usage.lot_id });
      continue;
    }
    if (lot.kind === "food") {
      const usable = lotUsable(lot, at);
      if (!usable.ok) problems.push({ kind: usable.reason, lot_id: lot.lotId });
      if (!labelIsCurrent(labelCatalog, lot.labelCode)) {
        problems.push({ kind: "label_not_current", lot_id: lot.lotId, label_code: lot.labelCode });
      }
    }
  }

  if (problems.length) fail(Codes.RELEASE_BLOCKED, "放行闸口未通过", { problems });
  return true;
}

export function batchSellable(batch) {
  if (batch.status !== "released") return 0;
  return batch.unitsReleased - batch.unitsBlocked - batch.unitsDisposed - batch.unitsRecalled;
}
