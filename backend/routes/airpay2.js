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

/** @returns {{fields:object, format:"json"|"form"}} */
function parseCallbackBody(raw, contentType) {
  const text = raw.toString("utf8");
  if (!text.trim()) throw new Error("empty");
  const looksJson = /json/i.test(contentType) || (!contentType && text.trim().startsWith("{"));
  if (looksJson) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { fields: parsed, format: "json" };
  }
  return { fields: Object.fromEntries(new URLSearchParams(text)), format: "form" };
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
  // Only comparable when both sides state it; INR (356) is the only currency sent.
  if (v.currencyCode && cb.currencyCode && v.currencyCode !== cb.currencyCode) return "currency";
  if (v.currencyCode && v.currencyCode !== "356") return "currency";
  return null;
}

/**
 * Browser return or server-to-server IPN? Both arrive at the same URL, and
 * AirPay documents no field that tells them apart.
 *
 *   "ipn"       JSON body. An HTML form cannot submit JSON, so no browser
 *               return can look like this.
 *   "browser"   form body with top-level-navigation markers (Accept: text/html,
 *               Sec-Fetch-Mode: navigate). A heuristic: a server could send them.
 *   "ambiguous" any other form body.
 *
 * The result picks the response BODY (HTML page vs JSON) and the log label
 * only. It never picks the HTTP status: that follows the processing outcome
 * alone, so a misread IPN still gets its 502/503 re-send signal.
 */
export function callbackChannel(headers) {
  const contentType = String(headers["content-type"] || "");
  if (/json/i.test(contentType)) return "ipn";
  const accept = String(headers.accept || "");
  const mode = String(headers["sec-fetch-mode"] || "");
  return /text\/html/i.test(accept) || /navigate/i.test(mode) ? "browser" : "ambiguous";
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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// `next`: send the customer on to this URL (used where a non-2xx status rules
// out a 303 redirect). Browsers render and follow it whatever the status.
const RETURN_PAGE = (title, next) => `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  (next ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(next)}">` : "") + `</head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1>` +
  (next
    ? `<p><a href="${escapeHtml(next)}">Continue to your order</a></p></body></html>`
    : `<p>You can close this window and return to the merchant.</p></body></html>`);

async function handleAirpay2Callback(req, res) {
  const contentType = String(req.headers["content-type"] || "");
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  // Same URL, different response style. See callbackChannel.
  const channel = callbackChannel(req.headers);
  const format = /json/i.test(contentType) ? "json" : "form";

  // One structured line per callback that reached verification. `delivered`
  // means KKChat answered 2xx — not that KKChat processed or credited anything.
  const summary = { provider: "airpay2", channel, format };
  const logSummary = (extra) =>
    console.log("[airpay2 callback] summary " + JSON.stringify({ ...summary, ...extra }));

  // Responses. The status is the processing outcome for EVERY channel; only the
  // body differs (HTML for a browser, JSON otherwise). A browser gets a 303 only
  // on a 2xx outcome, because a redirect would acknowledge a misread IPN.
  const html = channel === "browser";
  const reject = (status, error) =>
    html
      ? res.status(status).type("html").send(RETURN_PAGE("We could not process this payment response"))
      : res.status(status).json({ error });
  const done = ({ status = 200, body, orderId, returnStatus }) => {
    if (!html) return res.status(status).json(body);
    const next = orderId ? airpay2OrderRedirect(orderId, returnStatus) : null;
    if (status < 300 && next) return res.redirect(303, next);
    const title = status < 300 ? "Payment response received" : "We are confirming your payment";
    return res.status(status).type("html").send(RETURN_PAGE(title, next));
  };

  let body, sourceFormat;
  try {
    ({ fields: body, format: sourceFormat } = parseCallbackBody(raw, contentType));
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
    // Field NAMES only (never values): shows, for example, an encrypted
    // {merchant_id, response} envelope, which this route does not decrypt.
    const names = Object.keys(body).slice(0, 40).map((n) => n.slice(0, 40));
    console.warn(`[airpay2 callback] rejected: ${check.reason} ` + JSON.stringify({
      channel, format: sourceFormat,
      ...(check.reason === "incomplete" && {
        field_names: names,
        envelope_suspected: names.some((n) => /^(response|encdata|data)$/i.test(n)),
      }),
    }));
    return reject(400, "Invalid AirPay callback");
  }
  const cb = check.fields;
  const ref = { channel, orderid: cb.orderid, ap_transactionid: cb.apTxnId };
  Object.assign(summary, { orderid: cb.orderid, ap_transactionid: cb.apTxnId });
  const localOrderId = orders.has(cb.orderid) ? cb.orderid : null;
  const notForwarded = (reason) => ({ destination: "kkchat", status: "not_forwarded", reason });

  // 2. Authority: AirPay's own record, fetched server-side.
  const verified = await verifyTransaction({ orderid: cb.orderid, apTxnId: cb.apTxnId }, cfg);
  if (!verified.ok || !verified.found) {
    // Not verifiable right now: nothing settled, nothing forwarded. 503 = not
    // acknowledged; whether AirPay re-sends on it is unconfirmed.
    console.warn("[airpay2 callback] verify inconclusive:", verified.reason || "not_found", ref);
    logSummary({
      verification: verified.ok ? "not_found" : "unavailable",
      local_order: localOrderId ? "present" : "unknown",
      forwarding: notForwarded("unverified"),
    });
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
    logSummary({ verification: `mismatch_${mismatch}`, forwarding: notForwarded("mismatch") });
    return reject(400, "Verification mismatch");
  }

  // 3. Local settlement — independent of forwarding, and optional: callbacks
  //    for KKChat's own orders have no Firvanra order and that is expected.
  const local = settleLocalOrder(v, verified.outcome);
  Object.assign(summary, {
    verification: "verified",
    outcome: verified.outcome,
    local_order: local.local,
    ...(local.status && { local_status: local.status }),
    ...(local.reason && { local_reason: local.reason }),
  });
  const returnStatus =
    local.status === "paid" ? "success" : local.status === "failed" ? "failure" : null;

  // 4. Forward only a callback whose status AirPay's record confirms. A stale
  //    or premature callback is authentic but no longer (or not yet) true.
  const confirmed = classifyStatus(cb.txnStatus, cb.paymentStatus) === verified.outcome &&
    cb.txnStatus === v.txnStatus;
  if (!confirmed) {
    const claimsPaid = classifyStatus(cb.txnStatus, cb.paymentStatus) === "paid";
    console.warn("[airpay2 callback] not forwarded: status not confirmed by verify", ref);
    logSummary({ forwarding: notForwarded(claimsPaid ? "unconfirmed_success" : "superseded") });
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
    contentType: contentType ||
      (sourceFormat === "json" ? "application/json" : "application/x-www-form-urlencoded"),
    fields: body, // exactly what was verified; used when forwarding as JSON
    sourceFormat,
    dedupKey: `${cb.apTxnId}:${cb.txnStatus}`,
    logRef: cb.apTxnId,
    // Ids only, for the opt-in debug records. Query values are never relayed or logged.
    diag: { orderid: cb.orderid, apTxnId: cb.apTxnId, queryNames: Object.keys(req.query || {}) },
  });
  // Four separate facts: transport_delivered (KKChat answered 2xx),
  // response_valid (JSON as contracted), acknowledgement (KKChat confirmed
  // processing; "unconfirmed" = not established, whatever the HTTP status) and
  // payment_recorded (never known to Firvanra).
  const r = fwd.response;
  logSummary({
    forwarding: {
      destination: "kkchat",
      status: fwd.duplicate ? "duplicate" : fwd.ok ? "delivered" : "failed",
      ...(fwd.request_format && { request_format: fwd.request_format }),
      ...(fwd.request_content_type && { request_content_type: fwd.request_content_type }),
      ...(fwd.field_case && { field_case: fwd.field_case }),
      transport_delivered: Boolean(fwd.transport_delivered),
      ...(fwd.status !== undefined && { http_status: fwd.status }),
      ...(r && {
        response_content_type: r.content_type,
        response_kind: r.kind,
        response_json: r.json,
        response_content_type_json: r.content_type_json,
        response_valid: r.json === "parsed" && r.content_type_json,
        ...(r.issue && { response_issue: r.issue }),
        response_charset: r.charset,
        response_bytes: r.bytes,
        response_truncated: r.truncated,
        response_shape: r.shape,
        ...(r.word && { response_word: r.word }),
        ...(r.server && { response_server: r.server }),
      }),
      acknowledgement: fwd.acknowledgement || "unconfirmed",
      payment_recorded: "unconfirmed",
      ...(fwd.attempts !== undefined && { attempts: fwd.attempts }),
      // X-Firvanra-Relay-Id of each attempt: what KKChat can search its logs for.
      ...(fwd.relay_ids?.length && { relay_ids: fwd.relay_ids }),
      ...(fwd.error && { error: fwd.error }),
    },
  });

  if (!fwd.ok) {
    // Local settlement above already happened and stays. Not acknowledged, on
    // every channel, so a re-send (if AirPay makes one) gets another try.
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
