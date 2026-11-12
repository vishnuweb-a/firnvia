import { Router } from "express";
import { orders } from "./orders.js";
import {
  HDFC_GATEWAY,
  HdfcInputError,
  createSession,
  hdfcAvailable,
  hdfcConfig,
  hdfcInitiationBlockers,
  hdfcMissingConfig,
  hdfcWebhookConfigured,
  reconcileHdfcAttempt,
  verifyReturnSignature,
  verifyWebhookAuth,
} from "../services/hdfc.js";

// HDFC SmartGateway ("UPI — HDFC"). Separate from every other gateway: own
// routes, own config, no forwarding to any external service.
//
// Status authority: only HDFC's Order Status API, queried server-side by the
// SERVER-stored HDFC order id, moves an order. The signed browser return and
// the authenticated webhook are triggers for that query, never the decision.
//
// HDFC_SMARTGATEWAY_ENABLED gates NEW checkouts only. Returns, webhooks and
// reconciliation keep working while it is off, so late payments still settle.

// Routes, relative to the public domain (frontend/vercel.json proxies both):
export const HDFC_RETURN_PATH = "/payments/hdfc/return";
export const HDFC_WEBHOOK_PATH = "/api/webhooks/hdfc";

const FRONTEND_ORDER_BASE = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const orderRedirect = (orderId, returnStatus) => {
  const url = `${FRONTEND_ORDER_BASE}/order/${encodeURIComponent(orderId)}?status=pending&gateway=${HDFC_GATEWAY}`;
  return returnStatus ? `${url}&returnStatus=${returnStatus}` : url;
};

// HDFC order id -> local order id. In memory, like the order store itself.
const attemptIndex = new Map();
const initiating = new Set();

function findAttempt(hdfcOrderId) {
  const order = orders.get(attemptIndex.get(String(hdfcOrderId || "")));
  const attempt = order?.hdfcAttempts?.find((a) => a.hdfcOrderId === String(hdfcOrderId));
  return attempt ? { order, attempt } : null;
}

const router = Router();

// Frontend asks whether to show the option. Boolean only — never which
// variable is missing.
router.get("/availability", (_req, res) => {
  res.json({ enabled: hdfcAvailable() });
});

// Trust boundary: only orderId is read. Amount comes from the stored order.
router.post("/initiate", async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== "string")
    return res.status(400).json({ error: "orderId required." });

  const cfg = hdfcConfig();
  const blockers = hdfcInitiationBlockers(cfg);
  if (blockers.length) {
    console.error("[hdfc initiate] unavailable:", blockers.join(", "));
    return res.status(503).json({ error: "UPI — HDFC is unavailable." });
  }

  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid") return res.status(409).json({ error: "Order already paid." });
  if (initiating.has(order.id)) return res.status(409).json({ error: "Payment is already starting." });

  initiating.add(order.id);
  try {
    // Retry safety: never open a second payment while the previous one may
    // still complete. Its own HDFC record decides.
    const prev = order.hdfcAttempts?.[order.hdfcAttempts.length - 1];
    if (prev) {
      const r = await reconcileHdfcAttempt(order, prev, cfg);
      if (r.outcome === "unavailable")
        return res.status(503).json({ error: "Could not confirm the previous payment. Please try again shortly." });
      if (order.status === "paid") return res.status(409).json({ error: "Order already paid." });
      if (["PENDING_VBV", "AUTHORIZING", "PENDING"].includes(prev.providerStatus))
        return res.status(409).json({ error: "A payment for this order is still being confirmed." });
    }

    let session;
    try {
      session = await createSession(order, cfg);
    } catch (err) {
      if (err instanceof HdfcInputError) return res.status(400).json({ error: err.message });
      console.error("[hdfc initiate]", order.id, err.message);
      return res.status(502).json({ error: "Could not reach HDFC." });
    }

    const now = new Date().toISOString();
    const attempt = {
      hdfcOrderId: session.hdfcOrderId,
      providerOrderRef: session.providerOrderRef,
      customerId: session.customerId,
      amount: session.amount,
      currency: "INR",
      providerStatus: "NEW",
      verified: false,
      createdAt: now,
    };
    order.hdfcAttempts = [...(order.hdfcAttempts || []), attempt];
    attemptIndex.set(attempt.hdfcOrderId, order.id);
    order.gateway = HDFC_GATEWAY;
    order.hdfcOrderId = attempt.hdfcOrderId;
    order.paymentAttemptedAt = now;
    order.updatedAt = now;
    order.status = "pending";

    res.json({ provider: HDFC_GATEWAY, type: "redirect", checkoutUrl: session.checkoutUrl });
  } finally {
    initiating.delete(order.id);
  }
});

const PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>Please return to the merchant and check your order.</p></body></html>`;

// Browser return. HDFC posts (kits: "it's POST method"); GET is accepted too
// because the documented sample return URL carries the same query params.
export async function hdfcReturn(req, res) {
  const params = req.method === "POST" && Object.keys(req.body || {}).length ? req.body : req.query;
  const cfg = hdfcConfig();
  if (hdfcMissingConfig(cfg).length) {
    console.error("[hdfc return] configuration unavailable");
    return res.status(503).type("html").send(PAGE("We could not process this payment response"));
  }
  // Fails closed: an unsigned or tampered return changes nothing.
  if (!verifyReturnSignature(params, cfg.responseKey)) {
    console.warn("[hdfc return] rejected: signature");
    return res.status(400).type("html").send(PAGE("We could not process this payment response"));
  }
  const found = findAttempt(params.order_id);
  if (!found) {
    console.warn("[hdfc return] unknown order:", String(params.order_id || ""));
    return res.status(404).type("html").send(PAGE("Order not found"));
  }

  const { order, attempt } = found;
  attempt.returnStatus = String(params.status || "");
  attempt.returnedAt = new Date().toISOString();

  const r = await reconcileHdfcAttempt(order, attempt, cfg);
  console.log("[hdfc return] reconciled:", { orderId: order.id, outcome: r.outcome, status: order.status });
  const returnStatus = order.status === "paid" ? "success" : order.status === "failed" ? "failure" : null;
  return res.redirect(303, orderRedirect(order.id, returnStatus));
}

// Server-to-server webhook. Basic auth (dashboard username/password), then the
// Order Status API decides. Non-200 makes HDFC re-send; duplicates are safe
// because reconciliation is idempotent and a paid order never moves.
export async function hdfcWebhook(req, res) {
  const cfg = hdfcConfig();
  if (hdfcMissingConfig(cfg).length || !hdfcWebhookConfigured(cfg)) {
    console.error("[hdfc webhook] configuration unavailable");
    return res.status(503).json({ error: "HDFC is unavailable." });
  }
  if (!verifyWebhookAuth(req.headers.authorization, cfg)) {
    console.warn("[hdfc webhook] rejected: authorization");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const hdfcOrderId = req.body?.content?.order?.order_id;
  const found = hdfcOrderId ? findAttempt(hdfcOrderId) : null;
  if (!found) {
    console.warn("[hdfc webhook] unknown order:", String(hdfcOrderId || ""));
    return res.status(404).json({ error: "Order not found." });
  }

  const { order, attempt } = found;
  attempt.webhookEvent = String(req.body.event_name || "");
  attempt.webhookReceivedAt = new Date().toISOString();

  const r = await reconcileHdfcAttempt(order, attempt, cfg);
  if (r.outcome === "unavailable" || r.outcome === "not_found") {
    console.warn("[hdfc webhook] status inconclusive for", order.id, r.reason || r.outcome);
    return res.status(503).json({ error: "Verification temporarily unavailable." });
  }
  if (r.outcome === "mismatch") return res.status(400).json({ error: "Verification mismatch" });
  console.log("[hdfc webhook] reconciled:", { orderId: order.id, status: order.status });
  return res.status(200).json({ received: true, status: order.status });
}

export default router;
