import { EventStore } from "./eventStore.js";
import { Repository, SINGLETON_IDS } from "./repository.js";
import { DomainError, Codes } from "../domain/errors.js";
import { designUsableForProduction, licensesCoverElements, reduceCollaboration, reduceLicense } from "../domain/collaboration.js";
import { recipeUsable, reduceRecipe } from "../domain/recipe.js";
import { reduceCapacity } from "../domain/capacity.js";
import { currentLabelCode, initialLabelCatalog, labelIsCurrent, reduceLabelCatalog } from "../domain/labelCatalog.js";
import { lotAvailable, lotUsable, reduceLot } from "../domain/componentLot.js";
import { reduceBundleBatch, reduceBundleDefinition, verifyAssembly, verifyRelease } from "../domain/bundle.js";
import { assertCanReserve, reduceQuota } from "../domain/channelQuota.js";
import { assertOpen, assertSelectionsReady, reduceOrder } from "../domain/customerOrder.js";
import { buildSettlementLines, initialSettlement, reduceSettlement } from "../domain/settlement.js";

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

const INITIAL_STATE = {
  production_capacity: () => ({ buckets: new Map() }),
  label_catalog: initialLabelCatalog,
  partner_settlement: initialSettlement
};

// 应用层：每个命令先回放相关聚合、执行业务判定，
// 然后把涉及的多个流作为一次原子提交写入；任一不变量失败则整体不写入。
export class FulfillmentApp {
  #seq = 0;

  constructor({ store, clock } = {}) {
    this.store = store ?? new EventStore();
    // 无论存储是自建还是外部传入，都确保提交时用领域 reducer 演算不变量。
    this.store.configure(REDUCERS, INITIAL_STATE);
    this.repo = new Repository(this.store);
    this.clock = clock ?? (() => new Date().toISOString());
  }

  #id(prefix) {
    this.#seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.#seq}`;
  }

  // 同一 stream 的多组事件会被合并为一个条目（同一期望版本），
  // 例如一次冻结同时给一个渠道产生多条铺货冻结事件。
  #commit(rawEntries, at) {
    const merged = new Map();
    for (const entry of rawEntries) {
      if (!merged.has(entry.stream)) merged.set(entry.stream, { stream: entry.stream, expectedVersion: entry.expectedVersion, events: [] });
      const rec = merged.get(entry.stream);
      if (rec.expectedVersion !== entry.expectedVersion) {
        throw new DomainError(Codes.CONCURRENT_WRITE, `同一事务内流 ${entry.stream} 的期望版本不一致`);
      }
      rec.events.push(...entry.events);
    }
    const prepared = [...merged.values()].map((e) => ({
      stream: e.stream,
      expectedVersion: e.expectedVersion,
      events: e.events.map((ev) => ({
        event_id: ev.event_id ?? this.#id("evt"),
        event_type: ev.event_type,
        aggregate_id: ev.aggregate_id,
        occurred_at: ev.occurred_at ?? at ?? this.clock(),
        summary: ev.summary,
        data: ev.data ?? {}
      }))
    }));
    return this.store.commit(prepared, this.clock);
  }

  #version(aggregateType, aggregateId) {
    return this.repo.versionOf(aggregateType, aggregateId);
  }

  // 已放行批次中已被渠道铺货或补寄占用的份数（防止同一批货重复分配）。
  #batchCommittedUnits(batchId) {
    let committed = 0;
    for (const q of this.repo.quotas) {
      for (const s of q.supplies) if (s.bundleBatchId === batchId) committed += s.units;
    }
    for (const order of this.repo.orders) {
      for (const r of order.replacements) if (r.bundle_batch_id === batchId) committed += r.units;
    }
    return committed;
  }

  #batchAvailable(batch) {
    // 冻结/处置/召回中的批次不再可分配；正常批次按已放行减去已铺货/补寄占用。
    if (batch.status !== "released") return 0;
    return Math.max(0, batch.unitsReleased - this.#batchCommittedUnits(batch.bundleBatchId));
  }

  // ---------- 联名与授权 ----------

  registerCollaboration(cmd) {
    const id = cmd.collaboration_id ?? this.#id("collab");
    this.#commit([{
      stream: `collaboration_design:${id}`, expectedVersion: 0,
      events: [{ event_type: "COLLABORATION_REGISTERED", aggregate_id: id, summary: `登记联名 ${cmd.name}`, data: { collaboration_id: id, name: cmd.name, partner_terms: cmd.partner_terms ?? [] } }]
    }], cmd.at);
    return id;
  }

  licenseElement(cmd) {
    const id = cmd.license_id ?? this.#id("lic");
    this.#commit([{
      stream: `cultural_license:${id}`, expectedVersion: 0,
      events: [{ event_type: "CULTURAL_ELEMENT_LICENSED", aggregate_id: id, summary: `文化元素 ${cmd.element_name} 授权`, data: { ...cmd, license_id: id } }]
    }], cmd.at);
    return id;
  }

  // 授权收窄：只改授权状态本身；已生产批次的依据在入库时已固化，不回溯。
  narrowLicense(cmd) {
    const version = this.#version("cultural_license", cmd.license_id);
    this.#commit([{
      stream: `cultural_license:${cmd.license_id}`, expectedVersion: version,
      events: [{ event_type: "LICENSE_SCOPE_NARROWED", aggregate_id: cmd.license_id, summary: `授权收窄：${cmd.reason ?? ""}`, data: { design_version_ids: cmd.design_version_ids ?? [], reason: cmd.reason ?? "" } }]
    }], cmd.at);
  }

  clearDesignVersion(cmd) {
    const at = cmd.at ?? this.clock();
    // 审定动作发生时版本还未写入状态，单独核验授权对各元素的覆盖。
    const cover = licensesCoverElements(this.repo.licenses, cmd.cultural_element_ids, cmd.design_version_id, at);
    if (!cover.ok) {
      throw new DomainError(Codes.LICENSE_OUT_OF_SCOPE, `设计审定被拒：元素 ${cover.elementId} 授权不覆盖该版本`, cover);
    }
    const version = this.#version("collaboration_design", cmd.collaboration_id);
    this.#commit([{
      stream: `collaboration_design:${cmd.collaboration_id}`, expectedVersion: version,
      events: [{
        event_type: "DESIGN_CLEARED", aggregate_id: cmd.collaboration_id,
        summary: `设计版本 ${cmd.design_version_id} 审定放行`,
        data: { design_version_id: cmd.design_version_id, design_id: cmd.design_id, version: cmd.version, cultural_element_ids: cmd.cultural_element_ids }
      }]
    }], at);
  }

  supersedeDesignVersion(cmd) {
    const version = this.#version("collaboration_design", cmd.collaboration_id);
    this.#commit([{
      stream: `collaboration_design:${cmd.collaboration_id}`, expectedVersion: version,
      events: [{ event_type: "DESIGN_VERSION_SUPERSEDED", aggregate_id: cmd.collaboration_id, summary: `设计版本 ${cmd.design_version_id} 被替代`, data: { design_version_id: cmd.design_version_id, successor_version_id: cmd.successor_version_id } }]
    }], cmd.at);
  }

  // ---------- 配方与标签 ----------

  registerRecipe(cmd) {
    const id = cmd.recipe_id ?? this.#id("recipe");
    this.#commit([{
      stream: `food_recipe:${id}`, expectedVersion: 0,
      events: [{ event_type: "RECIPE_REGISTERED", aggregate_id: id, summary: `登记配方 ${cmd.name}（${cmd.flavor_name}）`, data: { ...cmd, recipe_id: id } }]
    }], cmd.at);
    return id;
  }

  approveLabel(cmd) {
    const version = this.repo.labelCatalogVersion();
    this.#commit([{
      stream: `label_catalog:${SINGLETON_IDS.label_catalog}`, expectedVersion: version,
      events: [{ event_type: "LABEL_VERSION_APPROVED", aggregate_id: SINGLETON_IDS.label_catalog, summary: `标签 ${cmd.label_code} 批准`, data: cmd }]
    }], cmd.at);
  }

  withdrawLabel(cmd) {
    const version = this.repo.labelCatalogVersion();
    this.#commit([{
      stream: `label_catalog:${SINGLETON_IDS.label_catalog}`, expectedVersion: version,
      events: [{ event_type: "LABEL_VERSION_WITHDRAWN", aggregate_id: SINGLETON_IDS.label_catalog, summary: `标签 ${cmd.label_code} 撤版`, data: cmd }]
    }], cmd.at);
  }

  declareCapacity(cmd) {
    const version = this.repo.capacityVersion();
    this.#commit([{
      stream: `production_capacity:${SINGLETON_IDS.production_capacity}`, expectedVersion: version,
      events: [{ event_type: "CAPACITY_DECLARED", aggregate_id: SINGLETON_IDS.production_capacity, summary: `${cmd.factory_id} ${cmd.production_date} ${cmd.production_mode} 产能 ${cmd.units}`, data: cmd }]
    }], cmd.at);
  }

  // 食品批次生产：配方有效 + 标签为当前批准版次 + 对应模式产能足够（原子扣减）。
  produceFoodBatch(cmd) {
    const at = cmd.at ?? this.clock();
    const recipe = this.repo.recipe(cmd.recipe_id);
    if (!recipeUsable(recipe)) throw new DomainError(Codes.UNKNOWN_FLAVOR, `配方 ${cmd.recipe_id} 不可用于生产`);
    const catalog = this.repo.labelCatalog;
    const labelCode = cmd.label_code ?? currentLabelCode(catalog, cmd.recipe_id);
    if (!labelIsCurrent(catalog, labelCode)) {
      throw new DomainError(Codes.LABEL_NOT_CURRENT, `食品批次必须挂当前批准标签，得到 ${labelCode ?? "空"}`, { label_code: labelCode });
    }
    const lotId = cmd.lot_id ?? this.#id("lot");
    this.#commit([
      {
        stream: `production_capacity:${SINGLETON_IDS.production_capacity}`, expectedVersion: this.repo.capacityVersion(),
        events: [{ event_type: "CAPACITY_CONSUMED", aggregate_id: SINGLETON_IDS.production_capacity, summary: `${recipe.productionMode} 产能扣减 ${cmd.units}（批次 ${lotId}）`, data: { production_mode: recipe.productionMode, factory_id: cmd.factory_id, production_date: cmd.production_date, units: cmd.units, lot_id: lotId } }]
      },
      {
        stream: `component_lot:${lotId}`, expectedVersion: 0,
        events: [
          { event_type: "FOOD_BATCH_PRODUCED", aggregate_id: lotId, summary: `食品批次 ${cmd.component_name} ${cmd.units} 份`, data: { ...cmd, lot_id: lotId, label_code: labelCode, flavor_id: recipe.flavorId, allergens: [...recipe.allergens], production_mode: recipe.productionMode, recipe_version: recipe.recipeVersion } },
          { event_type: "COMPONENT_ACCEPTED", aggregate_id: lotId, summary: `食品批次 ${lotId} 检验合格入库`, data: { lot_id: lotId } }
        ]
      }
    ], at);
    return lotId;
  }

  // 非食品部件入库：核验设计版次仍在授权范围内，并把“当时授权依据”固化到批次。
  receiveNonfoodComponent(cmd) {
    const at = cmd.at ?? this.clock();
    const check = designUsableForProduction(this.repo.collaboration(cmd.collaboration_id), this.repo.licenses, cmd.design_version_id, at);
    if (!check.ok) {
      throw new DomainError(check.reason === "license_out_of_scope" ? Codes.LICENSE_OUT_OF_SCOPE : Codes.DESIGN_VERSION_NOT_CLEARED, "非食品部件入库被拒：设计版次不可用", check);
    }

    const collab = this.repo.collaboration(cmd.collaboration_id);
    const versionInfo = collab.versions.get(cmd.design_version_id);
    const licenseBasis = [];
    for (const elementId of versionInfo.elementIds) {
      for (const license of this.repo.licenses.filter((l) => l.elementId === elementId)) {
        const active = license.status === "active" && (!license.validFrom || Date.parse(at) >= Date.parse(license.validFrom));
        if (active) {
          licenseBasis.push({ license_id: license.licenseId, element_id: license.elementId, partner_id: license.partnerId, scope_mode: license.scopeMode, valid_from: license.validFrom, valid_to: license.validTo, as_of: at });
        }
      }
    }

    const lotId = cmd.lot_id ?? this.#id("lot");
    this.#commit([{
      stream: `component_lot:${lotId}`, expectedVersion: 0,
      events: [
        { event_type: "NONFOOD_COMPONENT_RECEIVED", aggregate_id: lotId, summary: `非食品部件 ${cmd.component_name} 入库`, data: { ...cmd, lot_id: lotId, license_basis: licenseBasis } },
        { event_type: "COMPONENT_ACCEPTED", aggregate_id: lotId, summary: `非食品部件 ${lotId} 验收入库`, data: { lot_id: lotId } }
      ]
    }], at);
    return lotId;
  }

  // ---------- 组合与放行 ----------

  defineBundle(cmd) {
    const id = cmd.bundle_id ?? this.#id("bundle");
    this.#commit([{
      stream: `bundle_definition:${id}`, expectedVersion: 0,
      events: [{ event_type: "BUNDLE_DEFINED", aggregate_id: id, summary: `定义组合 ${cmd.name}`, data: { ...cmd, bundle_id: id } }]
    }], cmd.at);
    return id;
  }

  // 装配：BOM 全部部件齐备才可装配；同一部件可由多个批次凑齐，逐批次原子占用。
  assembleBundleBatch(cmd) {
    const at = cmd.at ?? this.clock();
    const definition = this.repo.bundleDefinition(cmd.bundle_id);
    const lotsById = new Map(cmd.component_lot_ids.map((id) => [id, this.repo.lot(id)]));
    verifyAssembly(definition, lotsById, cmd.units, at);

    const batchId = cmd.bundle_batch_id ?? this.#id("bbatch");
    const usages = [];
    const allocatedByLot = new Map();

    for (const required of definition.components) {
      const need = (required.units_per_bundle ?? 1) * cmd.units;
      let remaining = need;
      const candidates = cmd.component_lot_ids
        .map((id) => lotsById.get(id))
        .filter((lot) => lot.componentId === required.componentId);
      for (const lot of candidates) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, lotAvailable(lot));
        if (take <= 0) continue;
        usages.push({ lot_id: lot.lotId, kind: lot.kind, units: take, component_id: lot.componentId, label_code: lot.labelCode ?? null });
        allocatedByLot.set(lot.lotId, (allocatedByLot.get(lot.lotId) ?? 0) + take);
        remaining -= take;
      }
      if (remaining > 0) {
        throw new DomainError(Codes.INSUFFICIENT_COMPONENTS, `部件 ${required.componentId} 缺 ${remaining} 份`, { component_id: required.componentId, shortfall: remaining });
      }
    }

    const entries = [...allocatedByLot.entries()].map(([lotId, units]) => ({
      stream: `component_lot:${lotId}`, expectedVersion: this.#version("component_lot", lotId),
      events: [{ event_type: "COMPONENT_ALLOCATED", aggregate_id: lotId, summary: `批次 ${lotId} 占用 ${units} 份用于装配 ${batchId}`, data: { lot_id: lotId, bundle_batch_id: batchId, units } }]
    }));
    entries.push({
      stream: `bundle_batch:${batchId}`, expectedVersion: 0,
      events: [{ event_type: "BUNDLE_BATCH_ASSEMBLED", aggregate_id: batchId, summary: `组合批次 ${batchId} 装配 ${cmd.units} 份`, data: { bundle_batch_id: batchId, bundle_id: cmd.bundle_id, design_version_id: definition.designVersionId, units: cmd.units, component_usages: usages } }]
    });
    this.#commit(entries, at);
    return batchId;
  }

  // 放行闸口：全部部件 + 当前标签齐备，缺一不可。
  releaseBundleBatch(cmd) {
    const at = cmd.at ?? this.clock();
    const batch = this.repo.bundleBatch(cmd.bundle_batch_id);
    const definition = this.repo.bundleDefinition(batch.bundleId);
    const lotsById = new Map([...batch.componentUsages.keys()].map((id) => [id, this.repo.lot(id)]));
    verifyRelease(definition, batch, lotsById, this.repo.labelCatalog, at);
    const version = this.#version("bundle_batch", cmd.bundle_batch_id);
    this.#commit([{
      stream: `bundle_batch:${cmd.bundle_batch_id}`, expectedVersion: version,
      events: [{ event_type: "BUNDLE_RELEASED", aggregate_id: cmd.bundle_batch_id, summary: `组合批次 ${cmd.bundle_batch_id} 放行 ${cmd.units ?? batch.units} 份`, data: { bundle_batch_id: cmd.bundle_batch_id, units: cmd.units ?? batch.units } }]
    }], at);
  }

  // 标签换版：批次换装当前标签后才能重新参与放行。
  refreshLotLabel(cmd) {
    if (!labelIsCurrent(this.repo.labelCatalog, cmd.label_code)) {
      throw new DomainError(Codes.LABEL_NOT_CURRENT, `标签 ${cmd.label_code} 不是当前批准版次`);
    }
    const version = this.#version("component_lot", cmd.lot_id);
    this.#commit([{
      stream: `component_lot:${cmd.lot_id}`, expectedVersion: version,
      events: [{ event_type: "LOT_LABEL_REFRESHED", aggregate_id: cmd.lot_id, summary: `批次 ${cmd.lot_id} 换装标签 ${cmd.label_code}`, data: cmd }]
    }], cmd.at);
  }

  // ---------- 渠道配额与预售 ----------

  openQuota(cmd) {
    const id = cmd.quota_id ?? this.#id("quota");
    this.#commit([{
      stream: `channel_quota:${id}`, expectedVersion: 0,
      events: [{ event_type: "CHANNEL_QUOTA_OPENED", aggregate_id: id, summary: `渠道 ${cmd.channel_id}/${cmd.store_id ?? "-"} 开放 ${cmd.bundle_id} 配额`, data: { ...cmd, quota_id: id } }]
    }], cmd.at);
    return id;
  }

  supplyQuota(cmd) {
    const batch = this.repo.bundleBatch(cmd.bundle_batch_id);
    const available = this.#batchAvailable(batch);
    if (available < cmd.units) {
      throw new DomainError(Codes.INSUFFICIENT_SELLABLE, `组合批次 ${cmd.bundle_batch_id} 可铺货 ${available}，申请 ${cmd.units}`, { available, requested: cmd.units });
    }
    const version = this.#version("channel_quota", cmd.quota_id);
    const supplyId = cmd.supply_id ?? this.#id("supply");
    this.#commit([{
      stream: `channel_quota:${cmd.quota_id}`, expectedVersion: version,
      events: [{ event_type: "QUOTA_SUPPLIED", aggregate_id: cmd.quota_id, summary: `配额铺货 ${cmd.units} 份（批次 ${cmd.bundle_batch_id}）`, data: { ...cmd, supply_id: supplyId } }]
    }], cmd.at);
    return supplyId;
  }

  // 预售下单：保留与订单原子成立；可售不足直接拒绝，杜绝超卖。
  reserveOrder(cmd) {
    const at = cmd.at ?? this.clock();
    const quota = this.repo.quota(cmd.quota_id);
    assertCanReserve(quota, cmd.units, at);
    const orderId = cmd.order_id ?? this.#id("order");
    const reservationId = cmd.reservation_id ?? this.#id("rsv");
    this.#commit([
      {
        stream: `channel_quota:${cmd.quota_id}`, expectedVersion: quota.version,
        events: [{ event_type: "QUOTA_RESERVED", aggregate_id: cmd.quota_id, summary: `预售保留 ${cmd.units} 份（订单 ${orderId}）`, data: { quota_id: cmd.quota_id, reservation_id: reservationId, order_id: orderId, units: cmd.units, expires_at: cmd.expires_at ?? null } }]
      },
      {
        stream: `customer_order:${orderId}`, expectedVersion: 0,
        events: [{
          event_type: "ORDER_RESERVED", aggregate_id: orderId,
          summary: `订单 ${orderId} 预售建立`,
          data: { order_id: orderId, channel_id: quota.channelId, store_id: quota.storeId, quota_id: cmd.quota_id, reservation_id: reservationId, bundle_id: quota.bundleId, units: cmd.units, unit_price: cmd.unit_price ?? 0, fulfillment_type: cmd.fulfillment_type, partner_shares: cmd.partner_shares ?? {} }
        }]
      }
    ], at);
    return { orderId, reservationId };
  }

  confirmSelections(cmd) {
    const order = this.repo.order(cmd.order_id);
    assertOpen(order);
    const definition = this.repo.bundleDefinition(order.bundleId);
    for (const f of cmd.flavor_selections ?? []) {
      if (!definition.flavorIds.has(f.flavor_id)) throw new DomainError(Codes.UNKNOWN_FLAVOR, `组合 ${definition.bundleId} 不含口味 ${f.flavor_id}`);
    }
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "CUSTOMER_SELECTIONS_CONFIRMED", aggregate_id: cmd.order_id, summary: "消费者确认取货时间/口味/过敏原", data: cmd }]
    }], cmd.at);
  }

  // 支付：未过期则确认保留；迟到支付安全释放配额并拒绝收款。
  payOrder(cmd) {
    const at = cmd.at ?? this.clock();
    const order = this.repo.order(cmd.order_id);
    if (!order) throw new DomainError(Codes.ORDER_NOT_OPEN, "订单不存在");
    const quota = this.repo.quota(order.quotaId);
    const r = quota.reservations.get(order.reservationId);
    const expired = !r || r.status === "released" || (r.expiresAt && Date.parse(at) >= Date.parse(r.expiresAt));
    if (expired) {
      // 可能已被定时任务取消；若仍开放则顺带安全释放
      if (order.status !== "cancelled") this.#safeRelease(this.repo.order(cmd.order_id), this.repo.quota(order.quotaId), "payment_too_late", at);
      throw new DomainError(Codes.RESERVATION_EXPIRED, `订单 ${order.orderId} 保留已过期或释放，配额已安全回收，拒绝迟到支付`, { order_id: order.orderId });
    }
    assertOpen(order);

    const amount = cmd.amount ?? order.unitPrice * order.units;
    this.#commit([
      {
        stream: `channel_quota:${order.quotaId}`, expectedVersion: this.#version("channel_quota", order.quotaId),
        events: [{ event_type: "QUOTA_RESERVATION_CONFIRMED", aggregate_id: order.quotaId, summary: `保留 ${order.reservationId} 支付确认`, data: { reservation_id: order.reservationId, supply_id: cmd.supply_id ?? null } }]
      },
      {
        stream: `customer_order:${order.orderId}`, expectedVersion: this.#version("customer_order", order.orderId),
        events: [{ event_type: "PAYMENT_RECEIVED", aggregate_id: order.orderId, summary: `订单 ${order.orderId} 收款 ${amount}`, data: { order_id: order.orderId, amount } }]
      }
    ], at);
  }

  #safeRelease(order, quota, reason, at) {
    const r = quota.reservations.get(order.reservationId);
    const entries = [];
    // held（未支付）与 confirmed（已支付后取消/退款）都要安全释放对应配额。
    if (r && (r.status === "held" || r.status === "confirmed")) {
      entries.push({
        stream: `channel_quota:${order.quotaId}`, expectedVersion: this.#version("channel_quota", order.quotaId),
        events: [{ event_type: "QUOTA_RESERVATION_RELEASED", aggregate_id: order.quotaId, summary: `保留 ${order.reservationId} 释放（${reason}）`, data: { reservation_id: order.reservationId, reason } }]
      });
    }
    if (order.status !== "cancelled") {
      entries.push({
        stream: `customer_order:${order.orderId}`, expectedVersion: this.#version("customer_order", order.orderId),
        events: [{ event_type: "ORDER_CANCELLED", aggregate_id: order.orderId, summary: `订单 ${order.orderId} 取消（${reason}）`, data: { order_id: order.orderId, reason, release_reservation: !!(r && r.status === "held") } }]
      });
    }
    if (entries.length) this.#commit(entries, at);
  }

  cancelOrder(cmd) {
    const at = cmd.at ?? this.clock();
    const order = this.repo.order(cmd.order_id);
    assertOpen(order);
    const quota = this.repo.quota(order.quotaId);
    this.#safeRelease(order, quota, cmd.reason ?? "customer_cancelled", at);
  }

  // 定时任务：批量释放过期保留并取消对应订单。
  autoExpireReservations(at = this.clock()) {
    const released = [];
    for (const q of this.repo.quotas) {
      for (const r of q.reservations.values()) {
        if (r.status !== "held" || !r.expiresAt || Date.parse(at) < Date.parse(r.expiresAt)) continue;
        const order = this.repo.order(r.orderId);
        if (order && order.status !== "cancelled") {
          this.#safeRelease(order, this.repo.quota(q.quotaId), "reservation_expired", at);
          released.push(r.orderId);
        }
      }
    }
    return released;
  }

  // ---------- 履约：自提 / 快递 / 补寄 ----------

  completePickup(cmd) {
    const order = this.repo.order(cmd.order_id);
    assertOpen(order);
    assertSelectionsReady(order);
    if (!order.paid) throw new DomainError(Codes.ORDER_NOT_OPEN, "订单未支付，不能自提");
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "PICKUP_COMPLETED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.order_id} 门店自提完成`, data: cmd }]
    }], cmd.at);
  }

  dispatchShipment(cmd) {
    const order = this.repo.order(cmd.order_id);
    assertOpen(order);
    if (!order.paid) throw new DomainError(Codes.ORDER_NOT_OPEN, "订单未支付，不能发货");
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "SHIPMENT_DISPATCHED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.order_id} 快递发出`, data: cmd }]
    }], cmd.at);
  }

  deliverShipment(cmd) {
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "SHIPMENT_DELIVERED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.order_id} 快递签收`, data: cmd }]
    }], cmd.at);
  }

  reportDamage(cmd) {
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "DAMAGE_REPORTED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.order_id} 报损 ${cmd.units} 份`, data: cmd }]
    }], cmd.at);
  }

  // 破损补寄：另取已放行且未被占用的组合批次，全程可追溯到批次与部件。
  shipReplacement(cmd) {
    const batch = this.repo.bundleBatch(cmd.bundle_batch_id);
    const available = this.#batchAvailable(batch);
    if (available < cmd.units) throw new DomainError(Codes.INSUFFICIENT_SELLABLE, `补寄可售 ${available}，申请 ${cmd.units}`, { available });
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "REPLACEMENT_SHIPPED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.order_id} 补寄发出`, data: cmd }]
    }], cmd.at);
  }

  deliverReplacement(cmd) {
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "REPLACEMENT_DELIVERED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.order_id} 补寄签收`, data: cmd }]
    }], cmd.at);
  }

  // ---------- 检验异常 / 临期 / 召回（精确冻结） ----------

  failFlavorInspection(cmd) {
    const version = this.#version("food_recipe", cmd.recipe_id);
    this.#commit([{
      stream: `food_recipe:${cmd.recipe_id}`, expectedVersion: version,
      events: [{ event_type: "RECIPE_FLAVOR_INSPECTION_FAILED", aggregate_id: cmd.recipe_id, summary: `口味检验异常：${cmd.reason ?? ""}`, data: cmd }]
    }], cmd.at);
  }

  // 冻结某个食品批次：只影响它本身、含它的组合批次、对应铺货与未履约订单；
  // 不含该批次的香囊、茶饮、其他口味批次一律不动。
  quarantineFoodLot(cmd) {
    const at = cmd.at ?? this.clock();
    return this.#quarantineLot(cmd.lot_id, cmd.units, cmd.reason ?? "food_safety_hold", at);
  }

  #quarantineLot(lotId, units, reason, at) {
    const lot = this.repo.lot(lotId);
    if (!lot) throw new DomainError(Codes.LOT_NOT_USABLE, `批次 ${lotId} 不存在`);
    if (lot.status === "scrapped" || lot.status === "recalled") return { lot_id: lotId, bundle_batches: [], order_ids: [], cancelled_order_ids: [] };
    // 裸批次中尚未装配的可冻结量；已全部装配时为 0，但冻结仍要向下游传播。
    const freezable = lotAvailable(lot);
    const freezeUnits = units ?? freezable;

    const entries = [];
    if (freezeUnits > 0) {
      entries.push({
        stream: `component_lot:${lotId}`, expectedVersion: this.#version("component_lot", lotId),
        events: [{ event_type: "COMPONENT_QUARANTINED", aggregate_id: lotId, summary: `批次 ${lotId} 冻结 ${Math.min(freezeUnits, freezable)} 份：${reason}`, data: { lot_id: lotId, units: Math.min(freezeUnits, freezable), reason, reference: "inspection" } }]
      });
    }

    const affectedBatches = this.repo.bundleBatches.filter((b) => b.componentUsages.has(lotId));
    const affectedOrderIds = new Set();
    const cancelledOrderIds = new Set();
    // 记录每个渠道被冻结的铺货总量，随后据此处理其上的保留
    const quotaFreeze = new Map();

    for (const batch of affectedBatches) {
      entries.push({
        stream: `bundle_batch:${batch.bundleBatchId}`, expectedVersion: this.#version("bundle_batch", batch.bundleBatchId),
        events: [{ event_type: "BUNDLE_BATCH_BLOCKED", aggregate_id: batch.bundleBatchId, summary: `组合批次 ${batch.bundleBatchId} 因含批次 ${lotId} 冻结`, data: { bundle_batch_id: batch.bundleBatchId, units: batch.units - batch.unitsReleased, reason, lot_id: lotId } }]
      });
      // 渠道铺货只冻结来自该组合批次的部分（同一渠道多条铺货合并为同流多事件提交）。
      for (const quota of this.repo.quotas) {
        for (const supply of quota.supplies) {
          if (supply.bundleBatchId === batch.bundleBatchId && supply.sellable > 0) {
            quotaFreeze.set(quota.quotaId, (quotaFreeze.get(quota.quotaId) ?? 0) + supply.sellable);
            entries.push({
              stream: `channel_quota:${quota.quotaId}`, expectedVersion: this.#version("channel_quota", quota.quotaId),
              events: [{ event_type: "QUOTA_SUPPLY_QUARANTINED", aggregate_id: quota.quotaId, summary: `铺货 ${supply.supplyId} 因批次 ${batch.bundleBatchId} 冻结`, data: { supply_id: supply.supplyId, units: supply.sellable, reason } }]
            });
          }
        }
      }
    }

    // 处理被冻结渠道上的保留：先释放最晚建立的 held（并取消订单），
    // 仍超出剩余可售时再把 confirmed 订单挂起；茶香礼等无关渠道完全不动。
    for (const [quotaId, frozenUnits] of quotaFreeze) {
      const quota = this.repo.quota(quotaId);
      const remainingSellable = quota.supplies.reduce((sum, s) => sum + s.sellable, 0) - frozenUnits;
      const active = [...quota.reservations.values()]
        .filter((r) => r.status === "held" || r.status === "confirmed")
        .sort((a, b) => (b.confirmedAt ?? b.heldAt).localeCompare(a.confirmedAt ?? a.heldAt));
      const activeUnits = active.reduce((sum, r) => sum + r.units, 0);
      let excess = activeUnits - remainingSellable;

      for (const r of active) {
        if (excess <= 0) break;
        if (r.status !== "held") continue;
        excess -= r.units;
        entries.push({
          stream: `channel_quota:${quotaId}`, expectedVersion: this.#version("channel_quota", quotaId),
          events: [{ event_type: "QUOTA_RESERVATION_RELEASED", aggregate_id: quotaId, summary: `保留 ${r.reservationId} 因铺货冻结释放`, data: { reservation_id: r.reservationId, reason: "supply_quarantined" } }]
        });
        const order = this.repo.order(r.orderId);
        if (order && order.status !== "cancelled") {
          entries.push({
            stream: `customer_order:${r.orderId}`, expectedVersion: this.#version("customer_order", r.orderId),
            events: [{ event_type: "ORDER_CANCELLED", aggregate_id: r.orderId, summary: `订单 ${r.orderId} 因食品检验冻结取消，配额已释放`, data: { order_id: r.orderId, reason: "supply_quarantined", release_reservation: true } }]
          });
          cancelledOrderIds.add(r.orderId);
        }
      }
      for (const r of active) {
        if (excess <= 0) break;
        if (r.status !== "confirmed") continue;
        excess -= r.units;
        const order = this.repo.order(r.orderId);
        if (order && order.status !== "cancelled" && order.status !== "held") {
          entries.push({
            stream: `customer_order:${r.orderId}`, expectedVersion: this.#version("customer_order", r.orderId),
            events: [{ event_type: "ORDER_FULFILLMENT_HOLD", aggregate_id: r.orderId, summary: `订单 ${r.orderId} 因所购组合批次冻结暂缓履约`, data: { order_id: r.orderId, reason, lot_id: lotId } }]
          });
          affectedOrderIds.add(r.orderId);
        }
      }
    }

    this.#commit(entries, at);
    return { lot_id: lotId, bundle_batches: affectedBatches.map((b) => b.bundleBatchId), order_ids: [...affectedOrderIds], cancelled_order_ids: [...cancelledOrderIds] };
  }

  // 临期处置：食品批次报废 + 含该批次的组合批次按临期处置。
  disposeExpired(cmd) {
    const at = cmd.at ?? this.clock();
    const entries = [];
    for (const lotId of cmd.lot_ids ?? []) {
      const lot = this.repo.lot(lotId);
      const usable = lotUsable(lot, at);
      if (!usable.ok || lotAvailable(lot) <= 0) continue;
      entries.push({
        stream: `component_lot:${lotId}`, expectedVersion: this.#version("component_lot", lotId),
        events: [{ event_type: "COMPONENT_SCRAPPED", aggregate_id: lotId, summary: `批次 ${lotId} 临期报废`, data: { lot_id: lotId, units: lotAvailable(lot), reason: "near_expiry" } }]
      });
    }
    for (const batchId of cmd.bundle_batch_ids ?? []) {
      const batch = this.repo.bundleBatch(batchId);
      const remain = batch.units - (batch.unitsDisposed ?? 0);
      if (remain <= 0) continue;
      entries.push({
        stream: `bundle_batch:${batchId}`, expectedVersion: this.#version("bundle_batch", batchId),
        events: [{ event_type: "BUNDLE_BATCH_DISPOSED", aggregate_id: batchId, summary: `组合批次 ${batchId} 临期处置`, data: { bundle_batch_id: batchId, units: remain, reason: "near_expiry" } }]
      });
    }
    if (entries.length) this.#commit(entries, at);
  }

  // 召回：从食品批次或组合批次切入，通知所有可追到的订单（含已签收）。
  recall(cmd) {
    const at = cmd.at ?? this.clock();
    const batchIds = new Set(cmd.bundle_batch_ids ?? []);
    for (const lotId of cmd.lot_ids ?? []) {
      for (const b of this.repo.bundleBatches) if (b.componentUsages.has(lotId)) batchIds.add(b.bundleBatchId);
    }
    const entries = [];
    for (const lotId of cmd.lot_ids ?? []) {
      entries.push({
        stream: `component_lot:${lotId}`, expectedVersion: this.#version("component_lot", lotId),
        events: [{ event_type: "COMPONENT_RECALLED", aggregate_id: lotId, summary: `批次 ${lotId} 召回`, data: { lot_id: lotId, units: cmd.units ?? null, reason: cmd.reason } }]
      });
    }
    const orderIds = new Set();
    for (const batchId of batchIds) {
      entries.push({
        stream: `bundle_batch:${batchId}`, expectedVersion: this.#version("bundle_batch", batchId),
        events: [{ event_type: "BUNDLE_BATCH_RECALLED", aggregate_id: batchId, summary: `组合批次 ${batchId} 召回`, data: { bundle_batch_id: batchId, units: this.repo.bundleBatch(batchId).units, reason: cmd.reason } }]
      });
      for (const order of this.repo.orders) {
        const linked = order.bundleBatchId === batchId ||
          order.shipments.some((s) => s.bundle_batch_id === batchId) ||
          order.pickups.some((p) => p.bundle_batch_id === batchId) ||
          order.replacements.some((r) => r.bundle_batch_id === batchId);
        if (linked) orderIds.add(order.orderId);
      }
    }
    const recallId = cmd.recall_id ?? this.#id("recall");
    for (const orderId of orderIds) {
      entries.push({
        stream: `customer_order:${orderId}`, expectedVersion: this.#version("customer_order", orderId),
        events: [{ event_type: "ORDER_RECALL_NOTICE", aggregate_id: orderId, summary: `订单 ${orderId} 收到召回通知`, data: { order_id: orderId, recall_id: recallId, bundle_batch_ids: [...batchIds], reason: cmd.reason } }]
      });
    }
    this.#commit(entries, at);
    return { recall_id: recallId, bundle_batch_ids: [...batchIds], order_ids: [...orderIds] };
  }

  completeRemedy(cmd) {
    const version = this.#version("customer_order", cmd.order_id);
    this.#commit([{
      stream: `customer_order:${cmd.order_id}`, expectedVersion: version,
      events: [{ event_type: "REMEDY_COMPLETED", aggregate_id: cmd.order_id, summary: `订单 ${cmd.orderId} 召回善后完成（${cmd.remedy_type}）`, data: cmd }]
    }], cmd.at);
  }

  // ---------- 合作方结算 ----------

  settlePartner(cmd) {
    const at = cmd.at ?? this.clock();
    const settlementId = cmd.settlement_id ?? `settlement:${cmd.partner_id}:${cmd.period.from}`;
    const seen = new Set();
    const existing = this.repo.settlement(settlementId);
    if (existing?.lines) for (const id of existing.lines.keys()) seen.add(id);
    const lines = buildSettlementLines(this.repo.orders, cmd.partner_id, cmd.period, seen);
    const amount = lines.reduce((sum, l) => sum + l.amount, 0);
    this.#commit([{
      stream: `partner_settlement:${settlementId}`, expectedVersion: this.#version("partner_settlement", settlementId),
      events: [{ event_type: "SETTLEMENT_CLEARED", aggregate_id: settlementId, summary: `合作方 ${cmd.partner_id} 清算 ${lines.length} 单，合计 ${amount}`, data: { settlement_id: settlementId, partner_id: cmd.partner_id, period: cmd.period, lines, total_amount: amount } }]
    }], at);
    return { settlementId, lines, amount };
  }
}
