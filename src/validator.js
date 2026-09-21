import { EVENT_AGGREGATE } from "./eventCatalog.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

// 仅校验事件信封与类型对照；业务不变量由领域聚合负责。
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record) {
    if (!(record.event_type in EVENT_AGGREGATE)) errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && "event_type" in record && record.event_type in EVENT_AGGREGATE) {
    const expected = EVENT_AGGREGATE[record.event_type];
    if (record.aggregate_type !== expected) {
      errors.push(`事件 ${record.event_type} 应属于聚合 ${expected}，实际为 ${record.aggregate_type}`);
    }
  }
  if ("occurred_at" in record && !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 ISO 8601 日期时间");
  }
  if ("data" in record && (typeof record.data !== "object" || record.data === null || Array.isArray(record.data))) {
    errors.push("data 必须是对象");
  }
  return errors;
}
