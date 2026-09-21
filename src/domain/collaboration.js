// 文化元素授权与联名设计版次。
// 关键原则：授权收窄只影响“尚未生产”的版本；每个已生产批次
// 都会保存当时的授权快照（license_basis），历史依据不随后续变更重写。

export function reduceCollaboration(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "COLLABORATION_REGISTERED":
      return {
        collaborationId: d.collaboration_id,
        name: d.name,
        partnerTerms: d.partner_terms ?? [],
        versions: new Map(),
        registered: true
      };
    case "DESIGN_CLEARED": {
      const versions = new Map(state.versions);
      versions.set(d.design_version_id, {
        designId: d.design_id,
        version: d.version,
        elementIds: new Set(d.cultural_element_ids),
        status: "cleared",
        clearedAt: event.occurred_at
      });
      return { ...state, versions };
    }
    case "DESIGN_VERSION_SUPERSEDED": {
      const versions = new Map(state.versions);
      const prev = versions.get(d.design_version_id);
      if (!prev) return state;
      versions.set(d.design_version_id, { ...prev, status: "superseded", supersededAt: event.occurred_at, successor: d.successor_version_id });
      return { ...state, versions };
    }
    default:
      return state;
  }
}

export function reduceLicense(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "CULTURAL_ELEMENT_LICENSED":
      return {
        licenseId: d.license_id,
        collaborationId: d.collaboration_id,
        elementId: d.element_id,
        elementName: d.element_name,
        partnerId: d.partner_id,
        status: "active",
        scopeMode: "all", // all = 授权期内覆盖该元素的全部版本
        designVersionIds: new Set(),
        validFrom: d.valid_from,
        validTo: d.valid_to ?? null,
        history: [{ at: event.occurred_at, type: event.event_type }]
      };
    case "LICENSE_SCOPE_NARROWED": {
      // 收窄后仅允许显式列出的版本继续生产；缺省为空集（即全面停止新生产）。
      return {
        ...state,
        scopeMode: "versions",
        designVersionIds: new Set(d.design_version_ids ?? []),
        narrowedAt: event.occurred_at,
        history: [...state.history, { at: event.occurred_at, type: event.event_type, reason: d.reason }]
      };
    }
    default:
      return state;
  }
}

// 授权在某时刻是否覆盖指定设计版本。
export function licenseAllows(license, designVersionId, at) {
  if (!license || license.status !== "active") return false;
  const now = Date.parse(at);
  if (license.validFrom && now < Date.parse(license.validFrom)) return false;
  if (license.validTo && now > Date.parse(license.validTo)) return false;
  if (license.scopeMode === "all") return true;
  return license.designVersionIds.has(designVersionId);
}

// 设计版本能否用于“新生产”：已审定、未被替代、且每个元素的授权此刻仍覆盖。
export function designUsableForProduction(collaboration, licenses, designVersionId, at) {
  const v = collaboration?.versions.get(designVersionId);
  if (!v || v.status !== "cleared") return { ok: false, reason: "design_version_not_cleared" };
  const cover = licensesCoverElements(licenses, v.elementIds, designVersionId, at);
  return cover.ok ? { ok: true } : { ok: false, reason: "license_out_of_scope", elementId: cover.elementId };
}

// 仅核验授权覆盖（审定动作本身发生时，版本还未进入状态）。
export function licensesCoverElements(licenses, elementIds, designVersionId, at) {
  for (const elementId of elementIds) {
    const covers = licenses
      .filter((l) => l.elementId === elementId)
      .some((l) => licenseAllows(l, designVersionId, at));
    if (!covers) return { ok: false, elementId };
  }
  return { ok: true };
}
