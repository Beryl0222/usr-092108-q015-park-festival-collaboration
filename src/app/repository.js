import { reduceCollaboration, reduceLicense } from "../domain/collaboration.js";
import { reduceRecipe } from "../domain/recipe.js";
import { reduceCapacity } from "../domain/capacity.js";
import { initialLabelCatalog, reduceLabelCatalog } from "../domain/labelCatalog.js";
import { reduceLot } from "../domain/componentLot.js";
import { reduceBundleBatch, reduceBundleDefinition } from "../domain/bundle.js";
import { reduceQuota } from "../domain/channelQuota.js";
import { reduceOrder } from "../domain/customerOrder.js";
import { initialSettlement, reduceSettlement } from "../domain/settlement.js";

const REDUCERS = {
  collaboration_design: reduceCollaboration,
  cultural_license: reduceLicense,
  food_recipe: reduceRecipe,
  production_capacity: reduceCapacity,
  label_catalog: reduceLabelCatalog,
  component_lot: reduceLot,
  bundle_definition: reduceBundleDefinition,
  bundle_batch: reduceBundleBatch,
  channel_quota: reduceQuota,
  customer_order: reduceOrder,
  partner_settlement: reduceSettlement
};

const INITIAL = {
  production_capacity: () => ({ buckets: new Map() }),
  label_catalog: initialLabelCatalog,
  partner_settlement: initialSettlement
};

// 单例聚合（label_catalog / production_capacity / partner_settlement）使用固定 id。
export const SINGLETON_IDS = {
  label_catalog: "catalog",
  production_capacity: "all",
  partner_settlement: "all"
};

export class Repository {
  constructor(store) {
    this.store = store;
  }

  #replay(aggregateType, aggregateId) {
    const events = this.store.loadStream(`${aggregateType}:${aggregateId}`);
    let state = INITIAL[aggregateType] ? INITIAL[aggregateType]() : null;
    for (const event of events) state = REDUCERS[aggregateType](state, event);
    return { state, version: events.length };
  }

  #all(aggregateType) {
    const ids = [];
    for (const event of this.store.allEvents()) {
      if (event.aggregate_type === aggregateType && !ids.includes(event.aggregate_id)) ids.push(event.aggregate_id);
    }
    return ids.map((id) => ({ id, ...this.#replay(aggregateType, id) }));
  }

  collaboration(id) { return this.#replay("collaboration_design", id).state; }
  get licenses() { return this.#all("cultural_license").map((x) => x.state); }
  license(id) { return this.#replay("cultural_license", id).state; }
  recipe(id) { return this.#replay("food_recipe", id).state; }
  get recipes() { return this.#all("food_recipe").map((x) => x.state); }
  get capacity() { return this.#replay("production_capacity", SINGLETON_IDS.production_capacity).state; }
  capacityVersion() { return this.#replay("production_capacity", SINGLETON_IDS.production_capacity).version; }
  get labelCatalog() { return this.#replay("label_catalog", SINGLETON_IDS.label_catalog).state; }
  labelCatalogVersion() { return this.#replay("label_catalog", SINGLETON_IDS.label_catalog).version; }
  lot(id) { return this.#replay("component_lot", id).state; }
  get lots() { return this.#all("component_lot").map((x) => x.state); }
  lotVersion(id) { return this.#replay("component_lot", id).version; }
  bundleDefinition(id) { return this.#replay("bundle_definition", id).state; }
  get bundleDefinitions() { return this.#all("bundle_definition").map((x) => x.state); }
  bundleBatch(id) { return this.#replay("bundle_batch", id).state; }
  bundleBatchVersion(id) { return this.#replay("bundle_batch", id).version; }
  get bundleBatches() { return this.#all("bundle_batch").map((x) => x.state); }
  quota(id) { const r = this.#replay("channel_quota", id); return { ...r.state, version: r.version }; }
  quotaVersion(id) { return this.#replay("channel_quota", id).version; }
  get quotas() { return this.#all("channel_quota").map((x) => ({ ...x.state, version: x.version })); }
  order(id) { return this.#replay("customer_order", id).state; }
  orderVersion(id) { return this.#replay("customer_order", id).version; }
  get orders() { return this.#all("customer_order").map((x) => x.state); }
  settlement(id) { return this.#replay("partner_settlement", id).state; }
  settlementVersion(id) { return this.#replay("partner_settlement", id).version; }

  versionOf(aggregateType, aggregateId) {
    return this.store.loadStream(`${aggregateType}:${aggregateId}`).length;
  }
}
