import express, { Router } from "express";
import { orders } from "./orders.js";
import {
  AIRPAY2_GATEWAY,
  airpay2Config,
  airpay2MissingConfig,
  buildCheckoutForm,
  classifyStatus,
  normalizeAmount,
  verifyCallback,
  verifyTransaction,
} from "../services/airpay2.js";
import { forwardAirpay2Callback } from "../services/kkchatForwarder.js";

// AirPay 2 — second AirPay merchant. Fully separate from the original AirPay
// routes in payment.js: own credentials (*_2 env), own initiate endpoint, own
// callback/IPN URL, and KKChat forwarding of verified callbacks.
//
// Status authority: neither the browser return nor the IPN settles anything by
// itself. Both pass the CRC32 integrity check and are then confirmed against
// AirPay's Verify API, queried server-side. Only that record moves a local
// order, and only a callback whose status that record confirms is forwarded.

// Response URL and IPN URL configured on the AirPay 2 merchant dashboard:
//   https://firvanra.online/callback/cpm/arp_firvanra/collection
export const AIRPAY2_CALLBACK_PATH = "/callback/cpm/arp_firvanra/collection";

const FRONTEND_ORDER_BASE = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

const airpay2OrderRedirect = (orderId, returnStatus) => {
  const url = `${FRONTEND_ORDER_BASE}/order/${encodeURIComponent(orderId)}` +
    `?status=pending&gateway=${AIRPAY2_GATEWAY}`;
  return returnStatus ? `${url}&returnStatus=${encodeURIComponent(returnStatus)}` : url;
};

// ── Initiate ────────────────────────────────────────────────────────────────

const router = Router();

// Trust boundary: the frontend sends only an orderId. Amount, buyer details and
// every signed field are derived server-side from the stored order.
router.post("/initiate", async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== "string")
    return res.status(400).json({ error: "orderId required." });

  const cfg = airpay2Config();
  const missing = airpay2MissingConfig(cfg);
  if (missing.length) {
    // Variable NAMES only. Never simulated, never merchant 1's credentials.
    console.error("[airpay2 initiate] configuration missing:", missing.join(", "));
    return res.status(503).json({ error: "AirPay 2 is unavailable." });
  }

  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid")
    return res.status(409).json({ error: "Order already paid." });
  if (typeof order.total !== "number" || !Number.isFinite(order.total) || order.total <= 0)
    return res.status(400).json({ error: "Order total is invalid." });

  let form;
  try {
    form = await buildCheckoutForm(order, order.buyer || {}, cfg);
  } catch (err) {
    console.error("[airpay2 initiate]", orderId, err.message);
    return res.status(502).json({ error: "Could not reach AirPay 2." });
  }

  // Attempt metadata only — never the privatekey, checksum or token. These
  // fields are visible through GET /api/orders/:id.
  const now = new Date().toISOString();
  order.gateway            = AIRPAY2_GATEWAY;
  order.airpay2OrderId     = order.id;          // AirPay `orderid` for this attempt
  order.airpay2Amount      = order.total.toFixed(2);
  order.airpay2AttemptedAt = now;
  order.paymentAttemptedAt = now;
  order.updatedAt          = now;
  order.status             = "pending";

  res.json({ type: "form", gateway: AIRPAY2_GATEWAY, ...form });
});

// ── Callback / IPN ──────────────────────────────────────────────────────────

function parseCallbackBody(raw, contentType) {
  const text = raw.toString("utf8");
  if (!text.trim()) throw new Error("empty");
  const looksJson = /json/i.test(contentType) || (!contentType && text.trim().startsWith("{"));
  if (looksJson) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * Does AirPay's verified record describe the SAME transaction as the callback?
 * @returns {string|null} the first failing field, or null.
 */
function verifiedIdentityMismatch(cb, v, cfg) {
  if (v.orderid !== cb.orderid) return "orderid";
  if (v.apTxnId !== cb.apTxnId) return "ap_transactionid";
  if (v.merchantId && v.merchantId !== cfg.merchantId) return "merchant_id";
  const amount = normalizeAmount(v.amount);
  if (amount === null || amount !== normalizeAmount(cb.amount)) return "amount";
  return null;
}

/**
 * Apply AirPay's verified record to a matching LOCAL order, if there is one.
 * Never creates an order and never touches an order this gateway did not start.
 *
 * @returns {{local:string, status?:string, reason?:string}}
 *   local: "unknown" | "not_airpay2" | "mismatch" | "updated" | "unchanged"
 */
function settleLocalOrder(v, outcome) {
  const order = orders.get(v.orderid);
  if (!order) return { local: "unknown" };
  if (order.gateway !== AIRPAY2_GATEWAY || order.airpay2OrderId !== v.orderid)
    return { local: "not_airpay2" };

  let expected;
  try { expected = order.total.toFixed(2); } catch { return { local: "mismatch", reason: "order_total" }; }
  if (normalizeAmount(v.amount) !== expected) return { local: "mismatch", reason: "amount" };
  if (v.currencyCode && v.currencyCode !== "356") return { local: "mismatch", reason: "currency" };

  // A settled order is only ever re-confirmed by the transaction that paid it.
  if (order.status === "paid" && order.airpay2TransactionId && order.airpay2TransactionId !== v.apTxnId)
    return { local: "unchanged", status: order.status, reason: "different_txn_on_paid_order" };

  const now = new Date().toISOString();
  order.airpay2VerifiedStatus = v.txnStatus;
  order.airpay2VerifiedAt     = now;
  order.updatedAt             = now;

  if (outcome === "paid") {
    if (order.status !== "paid") {
      order.status = "paid";
      order.paidAt = now;
      order.airpay2TransactionId = v.apTxnId;
      order.apTransactionId = v.apTxnId; // same field the original AirPay sets
    }
    return { local: "updated", status: "paid" };
  }
  // Never regress a confirmed payment (late / out-of-order callbacks).
  if (order.status === "paid") return { local: "unchanged", status: "paid" };
  if (outcome === "failed") { order.status = "failed"; return { local: "updated", status: "failed" }; }
  if (outcome === "pending") { order.status = "pending"; return { local: "updated", status: "pending" }; }
  return { local: "unchanged", status: order.status }; // unknown provider status: don't guess
}

const RETURN_PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1>` +
  `<p>You can close this window and return to the merchant.</p></body></html>`;

async function handleAirpay2Callback(req, res) {
  const contentType = String(req.headers["content-type"] || "");
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  // Per docs.airpay.co.in/v4 the IPN is a JSON POST; the browser return is a
  // form POST from the customer's browser. Same URL, different response style.
  const channel = /json/i.test(contentType) ? "ipn" : "browser";

  // Responses. IPN: status codes AirPay can act on. Browser: a page or redirect.
  const reject = (status, error) =>
    channel === "ipn"
      ? res.status(status).json({ error })
      : res.status(status).type("html").send(RETURN_PAGE("We could not process this payment response"));
  const done = ({ status = 200, body, orderId, returnStatus }) => {
    if (channel === "ipn") return res.status(status).json(body);
    if (orderId) return res.redirect(303, airpay2OrderRedirect(orderId, returnStatus));
    return res.status(200).type("html").send(RETURN_PAGE("Payment response received"));
  };

  let body;
  try {
    body = parseCallbackBody(raw, contentType);
  } catch {
    console.warn("[airpay2 callback] rejected: malformed body", { channel });
    return reject(400, "Invalid AirPay callback");
  }

  const cfg = airpay2Config();
  if (airpay2MissingConfig(cfg).length) {
    console.error("[airpay2 callback] configuration unavailable");
    return reject(503, "AirPay 2 is unavailable.");
  }

  // 1. Integrity: completeness, merchant id, ap_SecureHash (CRC32).
  const check = verifyCallback(body, cfg);
  if (!check.ok) {
    console.warn("[airpay2 callback] rejected:", check.reason, { channel });
    return reject(400, "Invalid AirPay callback");
  }
  const cb = check.fields;
  const ref = { channel, orderid: cb.orderid, ap_transactionid: cb.apTxnId };
  const localOrderId = orders.has(cb.orderid) ? cb.orderid : null;

  // 2. Authority: AirPay's own record, fetched server-side.
  const verified = await verifyTransaction({ orderid: cb.orderid, apTxnId: cb.apTxnId }, cfg);
  if (!verified.ok || !verified.found) {
    // Not verifiable right now: nothing settled, nothing forwarded. 503 asks
    // AirPay to re-send the IPN later.
    console.warn("[airpay2 callback] verify inconclusive:", verified.reason || "not_found", ref);
    return done({
      status: 503,
      body: { error: "Verification temporarily unavailable." },
      orderId: localOrderId,
    });
  }

  const v = verified.fields;
  const mismatch = verifiedIdentityMismatch(cb, v, cfg);
  if (mismatch) {
    console.warn("[airpay2 callback] rejected: verify mismatch on", mismatch, ref);
    return reject(400, "Verification mismatch");
  }

  // 3. Local settlement — independent of forwarding, and optional: callbacks
  //    for KKChat's own orders have no Firvanra order and that is expected.
  const local = settleLocalOrder(v, verified.outcome);
  console.log("[airpay2 callback] verified:", { ...ref, outcome: verified.outcome, ...local });
  const returnStatus =
    local.status === "paid" ? "success" : local.status === "failed" ? "failure" : null;

  // 4. Forward only a callback whose status AirPay's record confirms. A stale
  //    or premature callback is authentic but no longer (or not yet) true.
  const confirmed = classifyStatus(cb.txnStatus, cb.paymentStatus) === verified.outcome &&
    cb.txnStatus === v.txnStatus;
  if (!confirmed) {
    const claimsPaid = classifyStatus(cb.txnStatus, cb.paymentStatus) === "paid";
    console.warn("[airpay2 callback] not forwarded: status not confirmed by verify", ref);
    // Claims success that AirPay has not confirmed yet: ask for a re-send.
    // Otherwise it is superseded; acknowledge so it is not retried forever.
    return done({
      status: claimsPaid ? 503 : 200,
      body: claimsPaid
        ? { error: "Verification temporarily unavailable." }
        : { received: true, forwarded: false, reason: "superseded" },
      orderId: localOrderId,
      returnStatus,
    });
  }

  const fwd = await forwardAirpay2Callback({
    rawBody: raw,
    contentType: contentType || "application/x-www-form-urlencoded",
    dedupKey: `${cb.apTxnId}:${cb.txnStatus}`,
    logRef: cb.apTxnId,
  });

  if (!fwd.ok) {
    // Local settlement above already happened and stays. The IPN is not
    // acknowledged so AirPay can re-send it and the relay gets another try.
    return done({
      status: 502,
      body: { error: "Callback relay failed." },
      orderId: localOrderId,
      returnStatus,
    });
  }

  return done({
    status: 200,
    body: { received: true, forwarded: true, duplicate: Boolean(fwd.duplicate) },
    orderId: localOrderId,
    returnStatus,
  });
}

// Own raw parser (registered in server.js BEFORE the global json/urlencoded
// parsers) so the exact bytes AirPay sent can be relayed to KKChat unchanged.
export const airpay2Callback = [
  express.raw({ type: () => true, limit: "100kb" }),
  handleAirpay2Callback,
];

// AirPay posts. A GET must never touch payment state.
export function airpay2CallbackMethodNotAllowed(_req, res) {
  res.set("Allow", "POST").status(405).json({ error: "Method Not Allowed" });
}

export default router;
