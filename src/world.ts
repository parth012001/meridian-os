// World = the shared state of the business. Every role reads it; only executed actions write it.
import { db, uid } from "./db.js";
import { MAX_RECOVERY_PCT } from "./charter.js";

export const today = (): string => (process.env.TODAY ?? new Date().toISOString().slice(0, 10));
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export interface Order { id: string; customer_id: string; project_name: string; promise_date: string; status: string; order_value: number; margin_pct: number; ship_policy: "complete" | "partial_ok"; branch: string; shipped_at: string | null; }
export interface PO { id: string; supplier_id: string; order_id: string; sku_id: string; qty: number; placed_at: string; acked_ship_date: string; current_ship_date: string; transit_days: number; status: string; expedited: number; }
export interface Sku { id: string; supplier_id: string; category: string; description: string; unit_cost: number; list_price: number; fire_rating: string | null; substitutable_group: string | null; }
export interface Supplier { id: string; name: string; product_lines: string; standard_lead_days: number; expedite_fee_usd: number; expedite_lead_days: number; }

export const getOrder = (id: string) => db().prepare("SELECT * FROM orders WHERE id=?").get(id) as Order | undefined;
export const listOpenOrders = () => db().prepare("SELECT * FROM orders WHERE status='open' ORDER BY promise_date").all() as Order[];
export const getCustomer = (id: string) => db().prepare("SELECT * FROM customers WHERE id=?").get(id) as any;
export const getSupplier = (id: string) => db().prepare("SELECT * FROM suppliers WHERE id=?").get(id) as Supplier;
export const getSku = (id: string) => db().prepare("SELECT * FROM skus WHERE id=?").get(id) as Sku;
export const posForOrder = (orderId: string) => db().prepare("SELECT * FROM purchase_orders WHERE order_id=? AND status='open'").all(orderId) as PO[];
export const openingsForOrder = (orderId: string) => db().prepare("SELECT * FROM openings WHERE order_id=? ORDER BY opening_no").all(orderId) as any[];
export const inventoryFor = (skuId: string) => db().prepare("SELECT * FROM inventory WHERE sku_id=?").all(skuId) as { sku_id: string; branch: string; qty_on_hand: number; qty_allocated: number }[];
/** Simulated supplier policy: Oakridge will not Fast Track fire-rated wood doors. One rule, used by the lever enumerator and the supplier channel alike. */
export const expediteEligible = (sku: Sku, sup: Supplier) => !sku.fire_rating || sup.id !== "SUP_OAK";

/** Expected arrival at our dock for a PO. */
export const poArrival = (po: PO) => addDays(po.current_ship_date, po.transit_days);

/** Deterministic risk assessment. This is the "Orders Actions window" a human checks by hand in Comsense. */
export interface Risk { order: Order; daysLate: number; latePOs: PO[]; reasons: string[]; score: number }
export function assessOrder(order: Order): Risk {
  const pos = posForOrder(order.id);
  const late = pos.filter(p => poArrival(p) > order.promise_date);
  const daysLate = late.length ? Math.max(...late.map(p => daysBetween(order.promise_date, poArrival(p)))) : 0;
  const reasons = late.map(p => `PO ${p.id} (${getSku(p.sku_id).description}) ships ${p.current_ship_date}, arrives ${poArrival(p)}, promise ${order.promise_date}`);
  const score = daysLate > 0 ? Math.round(daysLate * order.order_value * (0.5 + order.margin_pct) / 100) : 0;
  return { order, daysLate, latePOs: late, reasons, score };
}
export const assessAll = () => listOpenOrders().map(assessOrder);

export function recordEvent(type: string, payload: unknown, orderId?: string) {
  return Number(db().prepare("INSERT INTO events (type, order_id, payload) VALUES (?,?,?)").run(type, orderId ?? null, JSON.stringify(payload)).lastInsertRowid);
}
export const eventsForOrder = (orderId: string, type?: string) =>
  (type ? db().prepare("SELECT * FROM events WHERE order_id=? AND type=? ORDER BY id").all(orderId, type)
        : db().prepare("SELECT * FROM events WHERE order_id=? ORDER BY id").all(orderId)) as any[];

/** Apply a supplier acknowledgement slip: every open PO from that supplier for the given category slips n days. */
export function applySupplierSlip(supplierId: string, category: string, days: number, note: string) {
  const pos = db().prepare(`SELECT po.* FROM purchase_orders po JOIN skus s ON s.id=po.sku_id WHERE po.supplier_id=? AND s.category=? AND po.status='open' AND po.expedited=0`).all(supplierId, category) as PO[];
  const upd = db().prepare("UPDATE purchase_orders SET current_ship_date=? WHERE id=?");
  const touched: string[] = [];
  for (const po of pos) { upd.run(addDays(po.current_ship_date, days), po.id); touched.push(po.order_id); }
  const orderIds = [...new Set(touched)];
  recordEvent("supplier_ack_slip", { supplierId, category, days, note, orderIds });
  return orderIds;
}

// ── Recovery levers ───────────────────────────────────────────────────────────
export type LeverType = "transfer_stock" | "expedite_po" | "partial_ship" | "substitute_sku" | "change_promise_date";
export interface Lever {
  type: LeverType; po_id?: string; params: Record<string, unknown>;
  cost_usd: number; new_arrival?: string; days_saved: number; closes_gap: boolean;
  touches: string[]; requires: "nothing" | "owner approval" | "customer consent" | "owner approval and customer consent"; note: string;
}
export const TRANSFER_COST_PER_UNIT = 15;
export const PARTIAL_SHIP_FREIGHT = 120;

/** Enumerate every lever for an at-risk order, with cost and which Charter rules each touches. Pure read. */
export function findAlternatives(orderId: string): Lever[] {
  const order = getOrder(orderId); if (!order) return [];
  const { latePOs } = assessOrder(order);
  const out: Lever[] = [];
  const t = today();
  for (const po of latePOs) {
    const sku = getSku(po.sku_id); const sup = getSupplier(po.supplier_id);
    const gap = daysBetween(order.promise_date, poArrival(po));
    // 1. transfer from another branch
    for (const inv of inventoryFor(po.sku_id)) {
      const avail = inv.qty_on_hand - inv.qty_allocated;
      if (inv.branch !== order.branch && avail >= po.qty) {
        const arrival = addDays(t, 2);
        out.push({ type: "transfer_stock", po_id: po.id, params: { sku_id: po.sku_id, from_branch: inv.branch, to_branch: order.branch, qty: po.qty },
          cost_usd: po.qty * TRANSFER_COST_PER_UNIT, new_arrival: arrival, days_saved: gap + daysBetween(arrival, order.promise_date), closes_gap: arrival <= order.promise_date,
          touches: [], requires: "nothing", note: `${avail} on hand at ${inv.branch}` });
      }
    }
    // 2. expedite with the supplier (only when the supplier will honour it)
    if (expediteEligible(sku, sup)) {
      const expArrival = addDays(addDays(t, sup.expedite_lead_days), po.transit_days);
      out.push({ type: "expedite_po", po_id: po.id, params: { po_id: po.id, supplier_id: sup.id, fee_usd: sup.expedite_fee_usd, new_ship_date: addDays(t, sup.expedite_lead_days) },
        cost_usd: sup.expedite_fee_usd, new_arrival: expArrival, days_saved: daysBetween(expArrival, poArrival(po)), closes_gap: expArrival <= order.promise_date,
        touches: sup.expedite_fee_usd > order.order_value * MAX_RECOVERY_PCT ? ["C4"] : [], requires: "nothing", note: `${sup.name} expedite: ${sup.expedite_lead_days}d lead + ${po.transit_days}d transit, fee $${sup.expedite_fee_usd}` });
    }
    // 3. substitute an equivalent SKU in stock (same group AND same fire rating: C3)
    if (sku.substitutable_group) {
      const cands = db().prepare("SELECT * FROM skus WHERE substitutable_group=? AND id<>?").all(sku.substitutable_group, sku.id) as Sku[];
      for (const c of cands) {
        if ((c.fire_rating ?? null) !== (sku.fire_rating ?? null)) continue; // C3: never across ratings
        for (const inv of inventoryFor(c.id)) {
          if (inv.qty_on_hand - inv.qty_allocated >= po.qty) {
            const arrival = inv.branch === order.branch ? t : addDays(t, 2);
            const delta = Math.max(0, (c.unit_cost - sku.unit_cost) * po.qty);
            out.push({ type: "substitute_sku", po_id: po.id, params: { from_sku: sku.id, to_sku: c.id, qty: po.qty, branch: inv.branch },
              cost_usd: delta, new_arrival: arrival, days_saved: daysBetween(arrival, poArrival(po)), closes_gap: arrival <= order.promise_date,
              touches: ["C2"], requires: "customer consent", note: `${c.description} in stock at ${inv.branch}; needs customer consent` });
          }
        }
      }
    }
  }
  // 4. partial ship the openings that are ready
  if (latePOs.length && order.ship_policy === "partial_ok") {
    const lateSkus = new Set(latePOs.map(p => p.sku_id));
    const ready = openingsForOrder(orderId).filter(o => !lateSkus.has(o.door_sku) && !lateSkus.has(o.frame_sku)).length;
    if (ready > 0) out.push({ type: "partial_ship", params: { openings_ready: ready }, cost_usd: PARTIAL_SHIP_FREIGHT, days_saved: 0, closes_gap: false,
      touches: [], requires: "nothing", note: `${ready} openings can ship on time; late openings still need another lever` });
  }
  // 5. always available, always recommend-only
  // new date = the latest late arrival, so approving it actually closes the gap
  if (latePOs.length) out.push({ type: "change_promise_date", params: { new_promise_date: latePOs.map(poArrival).reduce((a, b) => (b > a ? b : a)) },
    cost_usd: 0, days_saved: 0, closes_gap: true, touches: ["C1"], requires: "owner approval", note: "renegotiate with customer; owner approval required" });
  for (const l of out) {
    const owner = l.touches.includes("C1") || l.touches.includes("C4");
    const consent = l.touches.includes("C2");
    l.requires = owner && consent ? "owner approval and customer consent" : consent ? "customer consent" : owner ? "owner approval" : "nothing";
  }
  const rank = (l: Lever) => (l.type === "change_promise_date" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || Number(b.closes_gap) - Number(a.closes_gap) || a.touches.length - b.touches.length || a.cost_usd - b.cost_usd);
}

/** Mutations, called ONLY by executeAction after the gate said execute. */
export function applyLever(lever: Lever, orderId: string) {
  const d = db(); const t = today();
  switch (lever.type) {
    case "transfer_stock": {
      const p = lever.params as any;
      d.prepare("UPDATE inventory SET qty_allocated = qty_allocated + ? WHERE sku_id=? AND branch=?").run(p.qty, p.sku_id, p.from_branch);
      d.prepare("UPDATE purchase_orders SET status='covered_by_transfer' WHERE id=?").run(lever.po_id);
      recordEvent("stock_transfer", p, orderId); break;
    }
    case "expedite_po": {
      const p = lever.params as any;
      d.prepare("UPDATE purchase_orders SET current_ship_date=?, expedited=1 WHERE id=?").run(p.new_ship_date, lever.po_id);
      recordEvent("po_expedited", p, orderId); break;
    }
    case "substitute_sku": {
      const p = lever.params as any;
      d.prepare("UPDATE inventory SET qty_allocated = qty_allocated + ? WHERE sku_id=? AND branch=?").run(p.qty, p.to_sku, p.branch);
      d.prepare("UPDATE purchase_orders SET status='cancelled_substituted' WHERE id=?").run(lever.po_id);
      d.prepare("UPDATE openings SET frame_sku = CASE WHEN frame_sku=? THEN ? ELSE frame_sku END, door_sku = CASE WHEN door_sku=? THEN ? ELSE door_sku END WHERE order_id=?").run(p.from_sku, p.to_sku, p.from_sku, p.to_sku, orderId);
      recordEvent("sku_substituted", p, orderId); break;
    }
    case "partial_ship": {
      recordEvent("partial_shipment", { ...lever.params, shipped_at: t }, orderId); break;
    }
    case "change_promise_date": {
      const p = lever.params as any;
      d.prepare("UPDATE orders SET promise_date=? WHERE id=?").run(p.new_promise_date, orderId);
      recordEvent("promise_date_changed", p, orderId); break;
    }
  }
}

export function kpis() {
  const d = db();
  const shipped = d.prepare("SELECT COUNT(*) c, SUM(CASE WHEN shipped_at<=promise_date THEN 1 ELSE 0 END) ok FROM orders WHERE status='shipped'").get() as any;
  const open = listOpenOrders(); const risks = open.map(assessOrder);
  const atRisk = risks.filter(r => r.daysLate > 0);
  const projectedOnTime = open.length ? (open.length - atRisk.length) / open.length : 1;
  const protectedRev = (d.prepare("SELECT COALESCE(SUM(o.order_value),0) v FROM tasks t JOIN orders o ON o.id=t.order_id WHERE t.outcome='recovered'").get() as any).v;
  const cost = (d.prepare("SELECT COALESCE(SUM(cost_usd),0) v FROM actions WHERE status='executed'").get() as any).v;
  return {
    open_orders: open.length, at_risk: atRisk.length, revenue_at_risk: atRisk.reduce((s, r) => s + r.order.order_value, 0),
    projected_on_time_rate: Number(projectedOnTime.toFixed(3)), historical_on_time_rate: shipped.c ? Number((shipped.ok / shipped.c).toFixed(3)) : null,
    revenue_protected: protectedRev, recovery_cost: cost,
    pending_approvals: (d.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get() as any).c,
  };
}
