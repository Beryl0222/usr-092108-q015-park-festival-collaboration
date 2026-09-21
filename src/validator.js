// 事件信封校验：必填字段、事件与聚合词表、时间格式。
// 词表与 contracts/domain.schema.json 保持一致，由 tests/contract.test.js 守护。

export const EVENT_TYPES = [
  "CAPACITY_DEFINED",
  "LICENSE_GRANTED",
  "LICENSE_NARROWED",
  "DESIGN_CLEARED",
  "RECIPE_REGISTERED",
  "BUNDLE_SPEC_DEFINED",
  "LABEL_PUBLISHED",
  "FOOD_BATCH_PRODUCED",
  "FOOD_BATCH_QUARANTINED",
  "FOOD_BATCH_DISPOSED",
  "COMPONENT_ACCEPTED",
  "BUNDLE_ASSEMBLED",
  "BUNDLE_RELEASED",
  "BUNDLE_HELD",
  "QUOTA_ALLOCATED",
  "ORDER_RESERVED",
  "RESERVATION_EXPIRED",
  "ORDER_CANCELLED",
  "ORDER_FULFILLED",
  "REMEDY_SHIPPED",
  "REMEDY_COMPLETED",
  "SETTLEMENT_RECORDED",
];

export const AGGREGATE_TYPES = [
  "capacity_pool",
  "cultural_license",
  "collaboration_design",
  "recipe",
  "bundle_spec",
  "food_batch",
  "component_lot",
  "bundle_batch",
  "channel_quota",
  "customer_order",
  "partner_settlement",
];

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("occurred_at" in record && !Number.isFinite(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是合法时间");
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) errors.push("summary 不能为空");
  if ("payload" in record && (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))) errors.push("payload 必须是对象");
  return errors;
}
