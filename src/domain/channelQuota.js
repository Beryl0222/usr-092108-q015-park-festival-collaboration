import { Codes, fail } from "./errors.js";

// 渠道配额：每个 (渠道/门店, 组合定义) 一行。
// 门店看到的“真实可售” = 已入配额且可售的组合批次份数 − 已保留份数，
// 而不是全网库存虚数。
//
// supply：已放行组合批次按渠道铺货（QUOTA_SUPPLIED），带 bundle_batch_id，
//         便于召回与批次追溯。
// reserve：预售/下单即保留；支付确认转为 confirmed；迟到支付（保留过期）或
//         取消订单则安全释放，保留可被再次售出。
// 一份保留生命周期 held -> confirmed（支付成功）或 released（超时/取消）。

export function reduceQuota(state, event) {
  const d = event.data;
  switch (event.event_type) {
    case "CHANNEL_QUOTA_OPENED":
      return {
        quotaId: d.quota_id,
        channelId: d.channel_id,
        storeId: d.store_id ?? null,
        bundleId: d.bundle_id,
        supplies: [], // { supply_id, bundle_batch_id, units, sellable, quarantined }
        reservations: new Map(),
        status: "open"
      };
    case "QUOTA_SUPPLIED": {
      const supplies = [...state.supplies, {
        supplyId: d.supply_id,
        bundleBatchId: d.bundle_batch_id,
        units: d.units,
        sellable: d.units,
        quarantined: 0,
        at: event.occurred_at
      }];
      return { ...state, supplies };
    }
    case "QUOTA_SUPPLY_QUARANTINED": {
      // 批次问题时，只冻结该铺货批次的可售量；其他批次与其他门店不动。
      const supplies = state.supplies.map((s) => {
        if (s.supplyId !== d.supply_id) return s;
        const units = d.units ?? s.sellable;
        if (units > s.sellable) fail(Codes.INSUFFICIENT_SELLABLE, `铺货 ${s.supplyId} 可售 ${s.sellable}，冻结 ${units}`);
        return { ...s, sellable: s.sellable - units, quarantined: s.quarantined + units };
      });
      return { ...state, supplies };
    }
    case "QUOTA_RESERVED": {
      const reservations = new Map(state.reservations);
      reservations.set(d.reservation_id, {
        reservationId: d.reservation_id,
        orderId: d.order_id,
        units: d.units,
        supplyId: d.supply_id ?? null, // 预售阶段可能只做额度保留，不锁具体批次
        status: "held",
        heldAt: event.occurred_at,
        expiresAt: d.expires_at ?? null
      });
      return { ...state, reservations };
    }
    case "QUOTA_RESERVATION_CONFIRMED": {
      const r = requireReservation(state, d.reservation_id);
      const reservations = new Map(state.reservations);
      reservations.set(r.reservationId, {
        ...r,
        status: "confirmed",
        supplyId: d.supply_id ?? r.supplyId,
        confirmedAt: event.occurred_at
      });
      return { ...state, reservations };
    }
    case "QUOTA_RESERVATION_RELEASED": {
      const r = requireReservation(state, d.reservation_id);
      const reservations = new Map(state.reservations);
      reservations.set(r.reservationId, { ...r, status: "released", releasedAt: event.occurred_at, reason: d.reason ?? null });
      return { ...state, reservations };
    }
    default:
      return state;
  }
}

function requireReservation(state, reservationId) {
  const r = state.reservations.get(reservationId);
  if (!r) fail(Codes.RESERVATION_NOT_HELD, `保留 ${reservationId} 不存在`);
  return r;
}

// 可售：所有铺货的 sellable 之和 − 仍 held 的保留。confirmed 已绑定具体货，
// 由 supply 维度扣减视图，此处简单口径：confirmed 也不再可售。
// 下限截到 0：铺货被整体冻结时，其上保留会被同步释放或转入售后，
// 不应让门店视图出现“负数库存”。
export function sellableUnits(state, at) {
  const supplySellable = state.supplies.reduce((sum, s) => sum + s.sellable, 0);
  let committed = 0;
  for (const r of state.reservations.values()) {
    if (r.status === "held") {
      if (!r.expiresAt || Date.parse(at) < Date.parse(r.expiresAt)) committed += r.units;
    } else if (r.status === "confirmed") {
      committed += r.units;
    }
  }
  return Math.max(0, supplySellable - committed);
}

// 预售口径：在已有可售之外，还允许按“预期到货”做纯额度保留时，需要单独登记；
// 本模型保守处理——保留不得超过当前 sellable（含已 held 的释放回收），
// 从根上杜绝全网虚数与超卖。
export function assertCanReserve(state, units, at) {
  const available = sellableUnits(state, at);
  if (units > available) {
    fail(Codes.INSUFFICIENT_SELLABLE, `可售不足：剩余 ${available}，申请保留 ${units}`, { available, requested: units });
  }
}

export function assertReservationPayable(state, reservationId, at) {
  const r = state.reservations.get(reservationId);
  if (!r || r.status !== "held") fail(Codes.RESERVATION_NOT_HELD, `保留 ${reservationId} 不可支付`);
  if (r.expiresAt && Date.parse(at) >= Date.parse(r.expiresAt)) fail(Codes.RESERVATION_EXPIRED, `保留 ${reservationId} 已过期`);
  return r;
}
