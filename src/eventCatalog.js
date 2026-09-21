// 事件类型与所属聚合的唯一对照表。
// 校验器用它核对 event_type 与 aggregate_type 是否匹配；
// 投影与仓储也以这里的注册为准。
export const EVENT_AGGREGATE = {
  COLLABORATION_REGISTERED: "collaboration_design",
  CULTURAL_ELEMENT_LICENSED: "cultural_license",
  LICENSE_SCOPE_NARROWED: "cultural_license",
  DESIGN_CLEARED: "collaboration_design",
  DESIGN_VERSION_SUPERSEDED: "collaboration_design",

  RECIPE_REGISTERED: "food_recipe",
  RECIPE_REVISED: "food_recipe",
  RECIPE_FLAVOR_INSPECTION_FAILED: "food_recipe",

  CAPACITY_DECLARED: "production_capacity",
  CAPACITY_CONSUMED: "production_capacity",

  LABEL_VERSION_APPROVED: "label_catalog",
  LABEL_VERSION_WITHDRAWN: "label_catalog",

  FOOD_BATCH_PRODUCED: "component_lot",
  NONFOOD_COMPONENT_RECEIVED: "component_lot",
  LOT_LABEL_REFRESHED: "component_lot",
  COMPONENT_ACCEPTED: "component_lot",
  COMPONENT_QUARANTINED: "component_lot",
  COMPONENT_ALLOCATED: "component_lot",
  COMPONENT_SCRAPPED: "component_lot",
  COMPONENT_RECALLED: "component_lot",

  BUNDLE_DEFINED: "bundle_definition",
  BUNDLE_BATCH_ASSEMBLED: "bundle_batch",
  BUNDLE_RELEASED: "bundle_batch",
  BUNDLE_BATCH_BLOCKED: "bundle_batch",
  BUNDLE_BATCH_DISPOSED: "bundle_batch",
  BUNDLE_BATCH_RECALLED: "bundle_batch",

  CHANNEL_QUOTA_OPENED: "channel_quota",
  QUOTA_SUPPLIED: "channel_quota",
  QUOTA_SUPPLY_QUARANTINED: "channel_quota",
  QUOTA_RESERVED: "channel_quota",
  QUOTA_RESERVATION_CONFIRMED: "channel_quota",
  QUOTA_RESERVATION_RELEASED: "channel_quota",

  ORDER_RESERVED: "customer_order",
  CUSTOMER_SELECTIONS_CONFIRMED: "customer_order",
  PAYMENT_RECEIVED: "customer_order",
  ORDER_CANCELLED: "customer_order",
  PICKUP_COMPLETED: "customer_order",
  SHIPMENT_DISPATCHED: "customer_order",
  SHIPMENT_DELIVERED: "customer_order",
  DAMAGE_REPORTED: "customer_order",
  REPLACEMENT_SHIPPED: "customer_order",
  REPLACEMENT_DELIVERED: "customer_order",
  ORDER_FULFILLMENT_HOLD: "customer_order",
  ORDER_RECALL_NOTICE: "customer_order",
  REMEDY_COMPLETED: "customer_order",

  SETTLEMENT_CLEARED: "partner_settlement"
};

export const AGGREGATE_TYPES = [...new Set(Object.values(EVENT_AGGREGATE))];
export const EVENT_TYPES = Object.keys(EVENT_AGGREGATE);

// 流标识约定：同一聚合的事件落在同一流，id 即业务标识。
export function streamIdFor(aggregateType, aggregateId) {
  return `${aggregateType}:${aggregateId}`;
}
