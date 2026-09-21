// 食品配方、口味与过敏原。
// 检验异常挂在“口味/配方版次”维度：受影响集合 = 使用该口味版次的食品批次，
// 与香囊、茶饮等无关口味/无关部件互不影响。

export function reduceRecipe(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "RECIPE_REGISTERED":
      return {
        recipeId: d.recipe_id,
        name: d.name,
        flavorId: d.flavor_id,
        flavorName: d.flavor_name,
        recipeVersion: d.recipe_version,
        allergens: new Set(d.allergens ?? []),
        weightGrams: d.weight_grams,
        productionMode: d.production_mode, // "handmade_900g" | "standard"
        netWeightSpec: d.net_weight_spec,
        status: "active",
        supersededBy: null
      };
    case "RECIPE_REVISED": {
      // 换版保留旧版次记录，旧批次继续指向旧版次。
      return {
        ...state,
        recipeVersion: d.recipe_version,
        allergens: new Set(d.allergens ?? state.allergens),
        status: "superseded",
        supersededBy: null
      };
    }
    case "RECIPE_FLAVOR_INSPECTION_FAILED":
      return { ...state, status: "inspection_failed", failedAt: event.occurred_at, reason: d.reason };
    default:
      return state;
  }
}

export function recipeUsable(recipe) {
  return !!recipe && recipe.status === "active";
}
