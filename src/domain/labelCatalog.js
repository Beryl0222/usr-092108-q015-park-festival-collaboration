// 食品标签版次目录（营养成分、过敏原、净含量等合规内容）。
// 任何 lot 必须挂载“当前批准”的标签版次才可参与装配放行；
// 标签撤版后，挂旧版次的 lot 不得继续用于新装配。

export function reduceLabelCatalog(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "LABEL_VERSION_APPROVED": {
      const versions = new Map(state.versions);
      const prev = versions.get(d.label_code);
      versions.set(d.label_code, {
        labelCode: d.label_code,
        version: d.label_version,
        appliesToRecipeIds: new Set(d.applies_to_recipe_ids ?? []),
        status: "approved",
        approvedAt: event.occurred_at,
        supersedes: d.supersedes ?? null
      });
      if (prev) {
        versions.set(prev.labelCode, { ...prev, status: "withdrawn", withdrawnBy: d.label_code });
      }
      return { ...state, versions, currentCodeByRecipe: indexCurrent(new Map(state.currentCodeByRecipe), versions) };
    }
    case "LABEL_VERSION_WITHDRAWN": {
      const versions = new Map(state.versions);
      const prev = versions.get(d.label_code);
      if (prev) versions.set(d.label_code, { ...prev, status: "withdrawn", withdrawnAt: event.occurred_at });
      return { ...state, versions, currentCodeByRecipe: indexCurrent(new Map(state.currentCodeByRecipe), versions) };
    }
    default:
      return state;
  }
}

function indexCurrent(prevIndex, versions) {
  const next = new Map(prevIndex);
  for (const v of versions.values()) {
    if (v.status !== "approved") continue;
    for (const recipeId of v.appliesToRecipeIds) next.set(recipeId, v.labelCode);
  }
  return next;
}

export function initialLabelCatalog() {
  return { versions: new Map(), currentCodeByRecipe: new Map() };
}

export function currentLabelCode(catalog, recipeId) {
  return catalog.currentCodeByRecipe.get(recipeId) ?? null;
}

export function labelIsCurrent(catalog, labelCode) {
  const v = catalog.versions.get(labelCode);
  return !!v && v.status === "approved";
}
