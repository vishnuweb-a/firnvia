import { Router } from "express";
import { nanoid } from "nanoid";
import { getProduct } from "../data/products.js";

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

router.get("/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(order);
});

export default router;
