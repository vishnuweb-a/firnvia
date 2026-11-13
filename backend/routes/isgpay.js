import { Router } from "express";
import { orders } from "./orders.js";
import {
  ISGPAY_GATEWAY,
  IsgpayInputError,
  buildSaleRequest,
  envelopeMismatch,
  isgpayAcknowledgement,
  isgpayAvailable,
  isgpayConfig,
  isgpayInitiationBlockers,
  isgpayLog,
  isgpayMissingConfig,
  openEnvelope,
  pathOf,
  reconcileAttempt,
} from "../services/isgpay.js";

// ISGPay (UAT) — mounted at /api/payments/isgpay. Separate from every other
// gateway; no external forwarding. UAT demo, not production-ready.
//
// ISGPAY_ENABLED gates NEW checkouts only; return/callback/status keep working
// while it is off so a late result can still settle.
//
// shortcut: attempts live in process memory (like the order store). A restart,
// redeploy or a request landing on another Vercel instance loses them, and the
// customer sees "Payment session unavailable". Durable storage would fix this.

const FRONTEND_BASE = (process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
const orderRedirect = (orderId) =>
  `${FRONTEND_BASE}/order/${encodeURIComponent(orderId)}?status=pending&gateway=${ISGPAY_GATEWAY}`;
// Not an order id (those start "FIR-"): the order page shows "session unavailable" on its 404.
const UNAVAILABLE_REDIRECT = `${FRONTEND_BASE}/order/session-unavailable?gateway=${ISGPAY_GATEWAY}`;

// TxnRefNo → local order id.
const attemptIndex = new Map();
const initiating = new Set();

function findAttempt(txnRefNo) {
  const order = orders.get(attemptIndex.get(String(txnRefNo || "")));
  const attempt = order?.isgpayAttempts?.find((a) => a.txnRefNo === String(txnRefNo));
  return attempt ? { order, attempt } : null;
}

const PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>Please return to the merchant and check your order.</p></body></html>`;

/**
 * Shared by return + callback: decrypt, verify hash, check identity + attempt,
 * record the signed result, then let the Status API decide.
 * @returns {Promise<{code:string, order?, result?}>}
 */
async function handleEnvelope(body, source) {
  const cfg = isgpayConfig();
  if (isgpayMissingConfig(cfg).length) return { code: "not_configured" };
  const opened = openEnvelope(body, cfg);
  if (!opened.ok) {
    isgpayLog(`${source}_received`, { ...opened.trace, result: "rejected", reason: opened.reason });
    return { code: "rejected" };
  }
  const f = opened.fields; // signature-verified from here on
  const found = findAttempt(f.TxnRefNo);
  const mismatch = found ? envelopeMismatch(f, found.attempt) : null;
  isgpayLog(`${source}_received`, { ...opened.trace, txnRefNo: f.TxnRefNo, attemptFound: !!found,
    amount: f.Amount ?? "absent", expectedAmount: found?.attempt.amount ?? null,
    consistency: found ? mismatch || "ok" : "not_checked", responseCode: f.ResponseCode ?? null,
    result: !found ? "unknown_attempt" : mismatch ? "rejected" : "accepted" });
  if (!found) return { code: "unknown" }; // lost in-memory session?
  const { order, attempt } = found;
  if (mismatch) return { code: "rejected" };
  // Verified signed values only — never trusted for "paid" on their own.
  attempt[`${source}ResponseCode`] = String(opened.fields.ResponseCode ?? "");
  attempt[`${source}At`] = new Date().toISOString();
  if (opened.fields.Amount) attempt.signedAmount = opened.fields.Amount;

  const result = await reconcileAttempt(order, attempt, cfg);
  console.log(`[isgpay ${source}] reconciled:`, { orderId: order.id, outcome: result.outcome, status: order.status });
  return { code: "ok", order, result };
}

const router = Router();

// Boolean only — never which variable is missing.
router.get("/availability", (_req, res) => res.json({ enabled: isgpayAvailable() }));

// Trust boundary: only orderId is read; the amount comes from the stored order.
router.post("/create", (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== "string") return res.status(400).json({ error: "orderId required." });

  const cfg = isgpayConfig();
  const blockers = isgpayInitiationBlockers(cfg);
  if (blockers.length) {
    console.error("[isgpay create] unavailable:", blockers.join(", "));
    return res.status(503).json({ error: "ISGPay is unavailable." });
  }
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid") return res.status(409).json({ error: "Order already paid." });
  if (initiating.has(order.id)) return res.status(409).json({ error: "Payment is already starting." });

  initiating.add(order.id);
  try {
    let sale;
    try { sale = buildSaleRequest(order, cfg); }
    catch (err) {
      if (err instanceof IsgpayInputError) return res.status(400).json({ error: err.message });
      console.error("[isgpay create]", order.id, err.message);
      return res.status(500).json({ error: "Could not start ISGPay." });
    }
    // Saved BEFORE the browser leaves, so the return/callback can find it.
    order.isgpayAttempts = [...(order.isgpayAttempts || []), sale.attempt];
    attemptIndex.set(sale.attempt.txnRefNo, order.id);
    order.gateway = ISGPAY_GATEWAY;
    order.paymentAttemptedAt = sale.attempt.createdAt;
    order.updatedAt = sale.attempt.createdAt;
    order.status = "pending";
    isgpayLog("sale_submit", { orderId: order.id, txnRefNo: sale.attempt.txnRefNo, amount: sale.attempt.amount,
      currency: sale.attempt.currency, method: "POST", endpoint: pathOf(sale.form.action),
      outerFields: Object.keys(sale.form.fields), encFields: sale.encFieldNames,
      encDataLength: sale.form.fields.EncData.length, version: cfg.version || "absent",
      payload: cfg.salePayload, target: sale.form.target });
    res.json({ provider: ISGPAY_GATEWAY, type: "form", attemptId: sale.attempt.txnRefNo, ...sale.form });
  } finally {
    initiating.delete(order.id);
  }
});

// Browser return (form POST). 303 to the order page; nothing decrypted goes in the URL.
router.post("/return", async (req, res) => {
  const r = await handleEnvelope(req.body, "return");
  if (r.code === "not_configured") return res.status(503).type("html").send(PAGE("We could not process this payment response"));
  if (r.code === "rejected") return res.status(400).type("html").send(PAGE("We could not process this payment response"));
  if (r.code === "unknown") return res.redirect(303, UNAVAILABLE_REDIRECT);
  return res.redirect(303, orderRedirect(r.order.id));
});

// Push callback (server-to-server). Only acknowledged once the Status API has
// answered; otherwise non-2xx so ISGPay re-posts (up to 3× / 30 min per PDF).
// Duplicates are safe: settlement is idempotent and a paid order never moves.
router.post("/callback", async (req, res) => {
  const r = await handleEnvelope(req.body, "callback");
  if (r.code === "not_configured") return res.status(503).json({ error: "Unavailable" });
  if (r.code === "rejected") return res.status(400).json({ error: "Invalid payload" });
  if (r.code === "unknown") return res.status(404).json({ error: "Unknown transaction" });
  if (r.result.outcome === "unavailable") return res.status(503).json({ error: "Verification temporarily unavailable" });
  if (r.result.outcome === "mismatch") return res.status(400).json({ error: "Verification mismatch" });
  const ack = isgpayAcknowledgement();
  return res.status(200).type(ack.contentType).send(ack.body);
});

const STATUS_MIN_INTERVAL_MS = 5000;

// Attempt status for the customer. attemptId is the unguessable TxnRefNo
// (64 random bits), the same capability model as order ids.
router.get("/status/:attemptId", async (req, res) => {
  const found = findAttempt(req.params.attemptId);
  if (!found) return res.status(404).json({ status: "unavailable",
    message: "Payment session unavailable; status could not be verified." });
  const { order, attempt } = found;
  let verification = attempt.verified ? "verified" : "pending";
  if (order.status === "pending" && Date.now() - (attempt.lastCheckedAt || 0) >= STATUS_MIN_INTERVAL_MS) {
    const r = await reconcileAttempt(order, attempt);
    if (r.outcome === "unavailable" || r.outcome === "mismatch") verification = "inconclusive";
  }
  res.json({ attemptId: attempt.txnRefNo, orderId: order.id, status: order.status, verification });
});

export default router;
