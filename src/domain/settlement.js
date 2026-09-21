import { Codes, fail } from "./errors.js";
import { fulfilledAt } from "./customerOrder.js";

// 合作方结算：按“实际履约完成”的订单清算（自提完成/快递签收/补寄签收）。
// 取消、未支付、未履约的订单不进入清算；已结算过的订单不得重复清算。

export function reduceSettlement(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "SETTLEMENT_CLEARED": {
      const lines = new Map(state.lines);
      for (const line of d.lines ?? []) {
        if (lines.has(line.order_id)) fail(Codes.SETTLEMENT_MISMATCH, `订单 ${line.order_id} 已在结算中`);
        lines.set(line.order_id, { ...line });
      }
      return {
        settlementId: state.settlementId ?? d.settlement_id,
        partnerId: state.partnerId ?? d.partner_id,
        period: state.period ?? d.period,
        lines,
        totalAmount: (state.totalAmount ?? 0) + (d.lines ?? []).reduce((sum, l) => sum + (l.amount ?? 0), 0),
        clearedAt: event.occurred_at
      };
    }
    default:
      return state;
  }
}

export function initialSettlement() {
  return { lines: new Map(), totalAmount: 0 };
}

// 从订单集合中挑出应进入某合作方当期清算的订单。
// partnerScope: partner_id -> 按订单收入分成角色参与；这里订单通过 data.partner_shares 记录。
export function buildSettlementLines(orders, partnerId, period, seenOrderIds) {
  const lines = [];
  for (const order of orders) {
    if (seenOrderIds.has(order.orderId)) continue;
    const at = fulfilledAt(order);
    if (!at) continue; // 未实际履约不清算
    if (!periodContains(period, at)) continue;
    const share = order.partnerShares?.[partnerId];
    if (share === undefined) continue;
    lines.push({
      order_id: order.orderId,
      fulfilled_at: at,
      amount: share,
      basis: order.paidAmount
    });
  }
  if (!lines.length) fail(Codes.NOTHING_TO_SETTLE, `合作方 ${partnerId} 在 ${period.from}~${period.to} 没有可清算的已履约订单`);
  return lines;
}

function periodContains(period, isoAt) {
  const at = Date.parse(isoAt);
  return (!period.from || at >= Date.parse(period.from)) && (!period.to || at <= Date.parse(period.to));
}
