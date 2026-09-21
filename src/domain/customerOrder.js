import { Codes, fail } from "./errors.js";

// 客户订单：预售保留 → 消费者确认（取货时间/口味/过敏原）→ 支付 → 履约
// （门店自提或快递）→ 破损补寄 / 召回通知 / 完结。
// 订单上记录所绑定的组合批次，保证从任一订单都能追到食品批次与文创部件。

export function reduceOrder(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "ORDER_RESERVED":
      return {
        orderId: d.order_id,
        channelId: d.channel_id,
        storeId: d.store_id ?? null,
        quotaId: d.quota_id,
        reservationId: d.reservation_id,
        bundleId: d.bundle_id,
        units: d.units,
        unitPrice: d.unit_price ?? 0,
        fulfillmentType: d.fulfillment_type, // "pickup" | "express"
        partnerShares: { ...(d.partner_shares ?? {}) }, // partner_id -> 分成金额
        status: "reserved",
        bundleBatchId: d.bundle_batch_id ?? null,
        selections: null,
        paid: false,
        paidAmount: 0,
        cancellations: [],
        pickups: [],
        shipments: [],
        replacements: [],
        damages: [],
        holds: [],
        recalls: [],
        remedies: []
      };
    case "CUSTOMER_SELECTIONS_CONFIRMED":
      return {
        ...state,
        selections: {
          pickupTime: d.pickup_time ?? null,
          flavors: (d.flavor_selections ?? []).map((f) => ({ ...f })),
          allergensAcknowledged: new Set(d.allergens_acknowledged ?? []),
          confirmedAt: event.occurred_at
        }
      };
    case "PAYMENT_RECEIVED":
      return { ...state, paid: true, paidAmount: d.amount, paidAt: event.occurred_at, status: "paid" };
    case "ORDER_CANCELLED":
      return {
        ...state,
        status: "cancelled",
        cancelledAt: event.occurred_at,
        cancellations: [...state.cancellations, { reason: d.reason, at: event.occurred_at, release: d.release_reservation !== false }]
      };
    case "ORDER_FULFILLMENT_HOLD":
      return { ...state, status: "held", holds: [...state.holds, { reason: d.reason, at: event.occurred_at, reference: d.reference ?? null }] };
    case "PICKUP_COMPLETED":
      return {
        ...state,
        status: "fulfilled",
        bundleBatchId: d.bundle_batch_id ?? state.bundleBatchId,
        pickups: [...state.pickups, { at: event.occurred_at, store_id: d.store_id, bundle_batch_id: d.bundle_batch_id ?? state.bundleBatchId }]
      };
    case "SHIPMENT_DISPATCHED":
      return {
        ...state,
        status: "shipped",
        bundleBatchId: d.bundle_batch_id ?? state.bundleBatchId,
        shipments: [...state.shipments, { shipment_id: d.shipment_id, carrier: d.carrier, dispatchedAt: event.occurred_at, deliveredAt: null, bundle_batch_id: d.bundle_batch_id ?? state.bundleBatchId }]
      };
    case "SHIPMENT_DELIVERED": {
      const shipments = state.shipments.map((s) =>
        s.shipment_id === d.shipment_id ? { ...s, deliveredAt: event.occurred_at } : s
      );
      return { ...state, status: "fulfilled", shipments };
    }
    case "DAMAGE_REPORTED":
      return {
        ...state,
        status: "damage_reported",
        damages: [...state.damages, { damage_id: d.damage_id, units: d.units, description: d.description, at: event.occurred_at }]
      };
    case "REPLACEMENT_SHIPPED":
      return {
        ...state,
        replacements: [...state.replacements, {
          replacement_id: d.replacement_id,
          damage_id: d.damage_id ?? null,
          units: d.units,
          bundle_batch_id: d.bundle_batch_id,
          carrier: d.carrier ?? null,
          shippedAt: event.occurred_at,
          deliveredAt: null
        }]
      };
    case "REPLACEMENT_DELIVERED": {
      const replacements = state.replacements.map((r) =>
        r.replacement_id === d.replacement_id ? { ...r, deliveredAt: event.occurred_at } : r
      );
      return { ...state, status: "fulfilled", replacements };
    }
    case "ORDER_RECALL_NOTICE":
      return { ...state, recalls: [...state.recalls, { recall_id: d.recall_id, bundle_batch_id: d.bundle_batch_id, at: event.occurred_at, reason: d.reason }] };
    case "REMEDY_COMPLETED":
      return {
        ...state,
        remedies: [...state.remedies, { remedy_id: d.remedy_id, type: d.remedy_type, at: event.occurred_at }],
        status: state.recalls.length ? "recall_remedied" : state.status
      };
    default:
      return state;
  }
}

export function assertOpen(order) {
  if (!order || order.status === "cancelled") fail(Codes.ORDER_NOT_OPEN, "订单不存在或已取消");
  if (order.status === "held") fail(Codes.ORDER_NOT_OPEN, "订单处于履约冻结状态");
}

export function assertSelectionsReady(order) {
  if (!order.selections) fail(Codes.SELECTIONS_NOT_CONFIRMED, "消费者尚未确认取货时间/口味/过敏原");
}

// 订单是否已实际履约完成（用于合作方按实际履约清算）：自提完成或快递签收。
// 破损订单以补寄签收为准：存在报损但补寄未全部签收时，不算履约完成。
export function fulfilledAt(order) {
  const deliveredReplacements = order.replacements.filter((r) => r.deliveredAt).length;
  if (order.damages.length > deliveredReplacements) return null;
  if (order.fulfillmentType === "pickup" && order.pickups.length) {
    return order.pickups[order.pickups.length - 1].at;
  }
  const lastShipment = order.shipments[order.shipments.length - 1];
  const delivered = lastShipment?.deliveredAt;
  const replacementDelivered = deliveredReplacements
    ? order.replacements.filter((r) => r.deliveredAt)[deliveredReplacements - 1].deliveredAt
    : null;
  return replacementDelivered ?? delivered ?? null;
}
