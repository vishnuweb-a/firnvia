import { Router } from "express";
import { nanoid } from "nanoid";
import { getProduct } from "../data/products.js";
import { HDFC_GATEWAY, refreshHdfcOrder } from "../services/hdfc.js";
import { hdfcDbEnabled, hydrateHdfcOrder } from "../services/hdfcStore.js";
import { refreshIsgpayOrder } from "../services/isgpay.js";

// In-memory order store -- INTENTIONALLY EPHEMERAL, NOT A BUG.
//
// Orders are held in process memory on purpose for this payment-flow
// demonstration. They are not durable across Vercel process replacement or
// scaling: a second serverless instance does not see orders created by the
// first, and any instance may be recycled at any time.
//
// This implementation exists to demonstrate the AirPay / SabPaisa / PayU gateway
// integration end to end. It is not durable commerce storage. No database was
// requested for this project -- do not add one (Postgres, Mongo, Redis, Prisma,
// Drizzle, Supabase) without an explicit requirement change.
// Exception (explicitly requested): HDFC orders are also persisted in a
// dedicated Supabase project behind HDFC_DB_ENABLED — see services/hdfcStore.js.
export const orders = new Map();

const router = Router();

// Create an order from a cart [{ id, qty }]
router.post("/", (req, res) => {
  const { items = [], buyer = {} } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "Cart is empty." });

  const lineItems = [];
  for (const { id, qty } of items) {
    const p = getProduct(id);
    if (!p) return res.status(400).json({ error: `Unknown product: ${id}` });
    const quantity = Math.max(1, parseInt(qty, 10) || 1);
    lineItems.push({ id: p.id, title: p.title, price: p.price, qty: quantity });
  }
  const total = lineItems.reduce((s, l) => s + l.price * l.qty, 0);

  const order = {
    id: `FIR-${nanoid(10)}`,
    items: lineItems,
    total,
    buyer,
    status: "pending", // pending -> paid | failed
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  res.json(order);
});

router.get("/:id", async (req, res) => {
  let order = orders.get(req.params.id);
  // HDFC only (HDFC_DB_ENABLED): reload from its dedicated store so the order
  // page recovers after a restart or on another instance. Store down -> memory.
  if (hdfcDbEnabled() && (!order || !order.gateway || order.gateway === HDFC_GATEWAY) && /^FIR-[A-Za-z0-9_-]{1,60}$/.test(req.params.id)) {
    try { order = (await hydrateHdfcOrder(orders, { websiteOrderId: req.params.id })) || order; }
    catch (err) { console.warn("[orders] hdfc store unavailable:", err.code || err.message); }
  }
  if (!order) return res.status(404).json({ error: "Order not found." });
  // Pending HDFC orders are re-checked against HDFC's Order Status API (throttled).
  await refreshHdfcOrder(order);
  await refreshIsgpayOrder(order); // same, for pending ISGPay orders via the Sale Status API
  res.json(order.gateway === HDFC_GATEWAY ? publicHdfcOrder(order) : order);
});

// Anyone holding the order link (no login on the return page) sees this, so:
// no buyer contact, no attempt internals (customer ref, unpaid HDFC ids).
const publicHdfcOrder = (o) => ({
  id: o.id, items: o.items, total: o.total, status: o.status, gateway: o.gateway, createdAt: o.createdAt,
  ...(o.status === "paid" ? { paidAt: o.paidAt, hdfcPaidOrderId: o.hdfcPaidOrderId, hdfcTxnId: o.hdfcTxnId } : {}),
});

export default router;
