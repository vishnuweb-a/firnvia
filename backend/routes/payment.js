import { Router } from "express";
import { orders } from "./orders.js";
import {
  buildCheckoutForm,
  verifyCallback as airpayVerify,
  airpayConfigured,
} from "../services/airpay.js";
import {
  initiatePayment as sabpaisaInitiate,
  verifyCallback as sabpaisaVerify,
  verifyWebhookSignature,
  sabpaisaConfigured,
  sabpaisaWebhookConfigured,
  sabpaisaEnquiryConfigured,
  enquireTransaction,
  rupeesToPaise,
  toPaise,
} from "../services/sabpaisa.js";
import {
  buildPayUCheckout,
  buildProductInfo,
  formatPayUAmount,
  payuConfigured,
  payuPublicConfig,
  verifyPayUResponseHash,
  verifyPayUPayment,
} from "../services/payu.js";

const router = Router();
const FRONTEND_BASE   = process.env.FRONTEND_URL || "http://localhost:5173";
const KKCHAT_CALLBACK = "https://kkchat.in/callback/cpm/sapa/collection";
const FRONTEND_ORDER_BASE = FRONTEND_BASE.replace(/\/+$/, "");

// Redirect target for a gateway browser return. `status=pending` always: the
// return carries no payment authority, so the order page must ask the backend.
const gatewayOrderRedirect = (gateway, orderId, returnStatus) => {
  const url = `${FRONTEND_ORDER_BASE}/order/${encodeURIComponent(orderId)}` +
    `?status=pending&gateway=${gateway}`;
  return returnStatus ? `${url}&returnStatus=${encodeURIComponent(returnStatus)}` : url;
};
const sabpaisaOrderRedirect = (orderId, returnStatus) =>
  gatewayOrderRedirect("sabpaisa", orderId, returnStatus);

// Forward SabPaisa data to kkchat.in (fire-and-forget).
//
// UNVERIFIED BUSINESS INTEGRATION — OWNER CONFIRMATION REQUIRED. Nothing in this
// repository explains what kkchat.in does with these payloads, and the relay is
// unauthenticated. Pending that confirmation the relay is preserved but
// constrained: it is only ever called on a CRYPTOGRAPHICALLY VERIFIED payload,
// and `verified` is stamped explicitly so the receiver can never read an
// unverified payload as a payment success. It is never called from PayU.
async function forwardToKkchat(data, { verified }) {
  if (!verified) {
    // Belt and braces: an unverified payload must not leave this process.
    console.warn("[sabpaisa forward] refused: payload not verified");
    return;
  }
  try {
    const fwd = await fetch(KKCHAT_CALLBACK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, verified: true }),
    });
    console.log("[sabpaisa forward] kkchat responded:", fwd.status);
  } catch (err) {
    // Failure here must never affect payment processing.
    console.error("[sabpaisa forward] failed:", err.message);
  }
}

// Simulation routes can set an order to "paid" with NO provider verification, so
// they must never be reachable in production. Unset/unknown NODE_ENV is treated
// as production: fail closed, never "assume development".
function simulationAllowed() {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}

// ── AirPay ──────────────────────────────────────────────────────────────────

router.post("/airpay/initiate", async (req, res) => {
  const { orderId } = req.body;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid")
    return res.status(409).json({ error: "Order already paid." });

  if (!airpayConfigured()) {
    // A payment gateway that is not configured is unavailable, not successful.
    // Offering a "simulated" checkout in production would hand the frontend a
    // path to a paid order with no provider involvement at all.
    if (!simulationAllowed()) {
      console.error("[airpay initiate] AirPay configuration unavailable");
      return res.status(503).json({ error: "AirPay is unavailable." });
    }
    return res.json({
      simulated: true,
      message: "AirPay credentials not set — returning simulated checkout.",
    });
  }

  try {
    const form = await buildCheckoutForm(order, order.buyer);
    res.json({ simulated: false, ...form });
  } catch (err) {
    console.error("[airpay initiate]", err.message);
    res.status(502).json({ error: `Could not reach AirPay: ${err.message}` });
  }
});

router.post("/airpay/callback", (req, res) => {
  const result = airpayVerify(req.body);
  console.log("[airpay callback]", {
    orderid: result.orderid, paid: result.paid, hashOk: result.ok,
  });
  const order = result.orderid ? orders.get(result.orderid) : null;
  if (order && result.ok && result.paid) {
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.apTransactionId = result.apTxnId;
    return res.redirect(`${FRONTEND_BASE}/order/${order.id}?status=success`);
  }
  if (order) order.status = "failed";
  res.redirect(`${FRONTEND_BASE}/order/${result.orderid || ""}?status=failed`);
});

// Development aid only. Hard-disabled outside an explicit development/test
// environment — same production gating as the SabPaisa simulate route: this
// route can set an order to "paid" with no provider verification whatsoever.
router.post("/airpay/simulate/:orderId", (req, res) => {
  if (!simulationAllowed()) {
    console.warn("[airpay simulate] blocked: NODE_ENV is not development/test");
    return res.status(404).json({ error: "Not found." });
  }
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.simulated = true;
  res.json(order);
});

// ── SabPaisa ─────────────────────────────────────────────────────────────────

// Trust boundary: the frontend sends only an orderId. The amount and the
// merchant transaction reference are derived server-side from the stored order.
//
// Status authority: the browser redirect below is UX only. An order reaches
// "paid" exclusively through the verified S2S webhook, and only when a
// server-side enquiry confirms it — see the webhook handler.
router.post("/sabpaisa/initiate", async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== "string")
    return res.status(400).json({ error: "orderId required." });

  if (!sabpaisaConfigured()) {
    // No simulated checkout: a payment gateway that cannot be reached is
    // unavailable, not successful.
    console.error("[sabpaisa initiate] SabPaisa configuration unavailable");
    return res.status(503).json({ error: "SabPaisa is unavailable." });
  }

  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid")
    return res.status(409).json({ error: "Order already paid." });

  let result;
  try {
    // Amount comes from order.total inside the adapter. Any amount in req.body
    // is ignored — it is never read here or passed on.
    result = await sabpaisaInitiate(order, order.buyer);
  } catch (err) {
    console.error("[sabpaisa initiate]", orderId, err.message);
    return res.status(502).json({ error: "Could not reach SabPaisa." });
  }

  // Attempt metadata only — never the checksum, the API key or the secret.
  const now = new Date().toISOString();
  order.gateway                 = "sabpaisa";
  order.sabpaisaMerchantTxnId   = result.merchantTxnId;
  order.sabpaisaPaymentId       = result.paymentId || null;
  order.sabpaisaAmountPaise     = result.amount;
  order.sabpaisaAttemptedAt     = now;
  order.paymentAttemptedAt      = now;   // kept: existing field name
  order.updatedAt               = now;
  order.status                  = "pending";
  if (result.expiresAt) order.sabpaisaSessionExpiresAt = result.expiresAt;
  if (result.gatewayTxnId) order.sabpaisaTxnId = result.gatewayTxnId;

  res.json({
    provider:    "sabpaisa",
    type:        "redirect",
    checkoutUrl: result.checkoutUrl,
  });
});

/**
 * Identity invariants shared by the browser return and the S2S webhook: a
 * cryptographically verified payload must still prove it belongs to THIS order
 * and THIS attempt before anything is recorded.
 *
 * Amount is deliberately NOT checked here. Return-URL and webhook amounts are
 * rupee representations; the authoritative paise comparison happens against the
 * enquiry API's canonical `amountPaise` in `reconcileSabpaisaOrder`.
 *
 * @returns {string|null} the name of the first failing invariant, or null.
 */
function sabpaisaOrderMismatch(order, { orderId }) {
  if (order.gateway !== "sabpaisa") return "gateway";
  if (String(orderId) !== String(order.id)) return "order_id";
  if (String(orderId) !== String(order.sabpaisaMerchantTxnId || "")) return "merchant_txn_id";
  // The order must carry a usable total, or nothing downstream can authorize.
  try { toPaise(order.total); } catch { return "order_total"; }
  return null;
}

/**
 * THE authority step for SabPaisa, shared by the browser return and the webhook.
 *
 * Queries the Transaction Enquiry API by the SERVER-stored merchantTxnId — never
 * a value from a request body — and applies the result as the final status.
 *
 * Invariants required before `paid`:
 *   enquiry status SUCCESS
 *   merchantTxnId === order.sabpaisaMerchantTxnId
 *   amountPaise   === toPaise(order.total)
 *   currency      === "INR"            (where the provider returns one)
 *   txnId         consistent with any already-known gateway txn id
 *
 * @param {object}  order
 * @param {string|null} knownTxnId gateway txn id from the verified payload, if any.
 * @returns {Promise<{outcome:string, reason?:string, status?:string}>}
 *   outcome: "paid" | "failed" | "pending" | "unavailable" | "not_found"
 *            | "mismatch" | "unknown"
 */
async function reconcileSabpaisaOrder(order, knownTxnId = null) {
  if (!sabpaisaEnquiryConfigured()) {
    // Without the enquiry endpoint there is no authoritative confirmation, so
    // nothing may be settled. Fails closed rather than trusting the payload.
    console.error("[sabpaisa reconcile] enquiry endpoint not configured");
    return { outcome: "unavailable", reason: "enquiry_not_configured" };
  }

  const verified = await enquireTransaction(order.sabpaisaMerchantTxnId);

  // Transport / provider trouble: leave the authoritative state untouched.
  if (!verified.ok) return { outcome: "unavailable", reason: verified.reason };
  // Eventual consistency — SabPaisa does not know this txn yet. Never a failure.
  if (!verified.found) return { outcome: "not_found" };

  let expectedPaise;
  try {
    expectedPaise = toPaise(order.total);
  } catch {
    return { outcome: "mismatch", reason: "order_total" };
  }

  if (String(verified.merchantTxnId) !== String(order.sabpaisaMerchantTxnId))
    return { outcome: "mismatch", reason: "merchant_txn_id" };

  // Compare the provider transaction id when BOTH sides have one.
  const priorTxnId = knownTxnId || order.sabpaisaTxnId || null;
  if (verified.txnId && priorTxnId && String(verified.txnId) !== String(priorTxnId))
    return { outcome: "mismatch", reason: "txn_id" };

  const classified = verified.outcome;
  const now = new Date().toISOString();

  order.sabpaisaVerifiedStatus = verified.status;
  order.sabpaisaVerifiedAt     = now;
  order.sabpaisaVerified       = true;
  order.updatedAt              = now;
  if (verified.paymentMode) order.sabpaisaPaymentMode = verified.paymentMode;
  if (verified.bankTxnId)   order.sabpaisaBankTxnId   = verified.bankTxnId;
  if (verified.bankRrn)     order.sabpaisaBankRrn     = verified.bankRrn;

  if (classified === "paid") {
    // Amount and currency gate the money decision only.
    if (verified.amountPaise === null || verified.amountPaise !== expectedPaise)
      return { outcome: "mismatch", reason: "amount" };
    if (verified.currency && String(verified.currency).toUpperCase() !== "INR")
      return { outcome: "mismatch", reason: "currency" };

    if (order.status !== "paid") {
      order.status     = "paid";
      order.paidAt     = verified.completedAt || now;
      order.paidAmount = verified.amountPaise;
    }
    order.sabpaisaTxnId = verified.txnId || priorTxnId || order.sabpaisaTxnId || null;
    return { outcome: "paid", status: "paid" };
  }

  // Never regress a payment SabPaisa already confirmed for this transaction.
  if (order.status === "paid") return { outcome: "paid", status: "paid" };

  if (classified === "failed") {
    order.status = "failed"; // no paidAt on failure
    return { outcome: "failed", status: "failed" };
  }
  if (classified === "pending") {
    order.status = "pending";
    return { outcome: "pending", status: "pending" };
  }

  // Unrecognized provider status: do not guess, keep the current state.
  console.warn("[sabpaisa reconcile] unknown status for", order.id, verified.status);
  return { outcome: "unknown", status: order.status };
}

// Browser redirect callback — SabPaisa sends the customer back here.
//
// The return itself carries NO payment authority: a verified signature only
// proves the payload came from SabPaisa. The order is settled solely by the
// Transaction Enquiry reconciliation below, which can contradict the return
// (return SUCCESS + enquiry PENDING => pending; + enquiry FAILED => failed).
async function handleSabpaisaCallback(req, res) {
  const data   = Object.keys(req.body || {}).length ? req.body : req.query;
  const result = sabpaisaVerify(data);

  if (!result.ok) {
    // Fails closed: unverifiable returns are not forwarded and change nothing.
    console.warn("[sabpaisa callback] rejected:", result.reason);
    return res.redirect(sabpaisaOrderRedirect(result.orderid || "", "failure"));
  }

  const order = result.orderid ? orders.get(result.orderid) : null;
  if (!order) {
    console.warn("[sabpaisa callback] order not in memory:", result.orderid);
    return res.redirect(sabpaisaOrderRedirect(result.orderid || "", "failure"));
  }

  const mismatch = sabpaisaOrderMismatch(order, { orderId: result.orderid });
  if (mismatch) {
    console.warn("[sabpaisa callback] rejected:", mismatch, "mismatch for", order.id);
    return res.redirect(sabpaisaOrderRedirect(order.id, "failure"));
  }

  // Verified and identity-matched. Forward only now, and only as a verified
  // RETURN — never as a payment success.
  forwardToKkchat({ ...data, stage: "browser_return" }, { verified: true });

  // Safe metadata only. The raw payload and the signature are not persisted.
  const now = new Date().toISOString();
  order.sabpaisaReturnVerified   = true;
  order.sabpaisaReturnStatus     = result.statusText;
  order.sabpaisaReturnTxnId      = result.txnId ? String(result.txnId) : null;
  order.sabpaisaReturnReceivedAt = now;
  order.sabpaisaReturnedAt       = now;   // kept: existing field name
  order.updatedAt                = now;

  // ── Authority step: SabPaisa's own record decides. ────────────────────────
  const reconciled = await reconcileSabpaisaOrder(order, result.txnId || null);

  if (reconciled.outcome === "unavailable" || reconciled.outcome === "not_found") {
    // Never expose an internal provider error to the customer's browser.
    console.warn("[sabpaisa callback] enquiry inconclusive for", order.id, reconciled.reason || "");
    return res.redirect(sabpaisaOrderRedirect(order.id));
  }
  if (reconciled.outcome === "mismatch") {
    console.warn("[sabpaisa callback] reconciliation mismatch:", reconciled.reason, "for", order.id);
    return res.redirect(sabpaisaOrderRedirect(order.id, "failure"));
  }

  const returnStatus =
    reconciled.outcome === "paid"   ? "success" :
    reconciled.outcome === "failed" ? "failure" : null;

  console.log("[sabpaisa callback] reconciled:", { orderId: order.id, status: reconciled.status });
  return res.redirect(sabpaisaOrderRedirect(order.id, returnStatus));
}


router.get("/sabpaisa/callback",  handleSabpaisaCallback);
router.post("/sabpaisa/callback", handleSabpaisaCallback);

// Development aid only. Hard-disabled outside an explicit development
// environment: this route can set an order to "paid" with no provider
// verification whatsoever, so it must never be reachable in production.
router.post("/sabpaisa/simulate/:orderId", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    console.warn("[sabpaisa simulate] blocked in production");
    return res.status(404).json({ error: "Not found." });
  }
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    // Unset/unknown NODE_ENV is treated as production. Fail closed.
    console.warn("[sabpaisa simulate] blocked: NODE_ENV is not development");
    return res.status(404).json({ error: "Not found." });
  }
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.simulated = true;
  res.json(order);
});

// In-memory idempotency store. Resets on restart, which is safe: a replayed
// webhook re-runs the same verified, amount-checked transition to the same state.
const processedWebhooks = new Set();

// SabPaisa server-to-server webhook — the ONLY path that may settle a SabPaisa
// order, and (where an enquiry endpoint is configured) only after SabPaisa's own
// record independently confirms the payment.
// Register as: <PUBLIC_BASE_URL>/api/payment/sabpaisa/webhook
//
// Pipeline: HMAC signature -> order invariants -> amount -> enquiry -> final state.
router.post("/sabpaisa/webhook", async (req, res) => {
  if (!sabpaisaConfigured() || !sabpaisaWebhookConfigured()) {
    // Fails closed: with no webhook secret there is no way to distinguish a
    // genuine webhook from a forged one, so nothing is accepted.
    console.error("[sabpaisa webhook] verification configuration unavailable");
    return res.status(503).json({ error: "SabPaisa is unavailable." });
  }

  const sigHeader = req.headers["x-sabpaisa-signature"] || "";
  // Never fall back to re-serializing req.body: the signature covers exact bytes.
  const rawBody   = req.rawBody;

  const { ok, reason } = verifyWebhookSignature(sigHeader, rawBody);
  if (!ok) {
    console.warn("[sabpaisa webhook] rejected:", reason);
    return res.status(400).json({ error: "Invalid signature" });
  }

  const body = req.body || {};
  const { event, txn_id, merchant_txn_id, status, request_amount, paid_amount,
          idempotency_key } = body;
  console.log("[sabpaisa webhook] verified:", { event, merchant_txn_id, status });

  const orderId = merchant_txn_id ? String(merchant_txn_id).trim() : "";
  if (!orderId) {
    console.warn("[sabpaisa webhook] rejected: merchant_txn_id missing");
    return res.status(400).json({ error: "Invalid SabPaisa webhook" });
  }

  const order = orders.get(orderId);
  if (!order) {
    console.warn("[sabpaisa webhook] order not in memory:", orderId);
    return res.status(404).json({ error: "Order not found." });
  }

  const mismatch = sabpaisaOrderMismatch(order, { orderId });
  if (mismatch) {
    console.warn("[sabpaisa webhook] rejected:", mismatch, "mismatch for", orderId);
    return res.status(400).json({ error: "Invalid SabPaisa webhook" });
  }

  // Cross-transaction safety: a settled order may only ever be re-confirmed by
  // the same gateway transaction that settled it.
  const gatewayTxnId = txn_id ? String(txn_id) : null;
  if (order.status === "paid" && order.sabpaisaTxnId && gatewayTxnId &&
      order.sabpaisaTxnId !== gatewayTxnId) {
    console.warn("[sabpaisa webhook] rejected: different txn for a paid order:", orderId);
    return res.status(409).json({ error: "Order already paid." });
  }

  // Idempotency — at-least-once delivery means duplicates are expected. Checked
  // only after verification, so an attacker cannot poison the key set. A replay
  // returns 200 without re-running reconciliation, so `paidAt` never moves.
  if (idempotency_key) {
    if (processedWebhooks.has(idempotency_key)) {
      console.log("[sabpaisa webhook] duplicate, skipping:", idempotency_key);
      return res.status(200).json({ received: true, status: order.status });
    }
    processedWebhooks.add(idempotency_key);
  }

  // Non-authoritative sanity check. Webhook amounts are rupee representations,
  // so a mismatch here is logged but never decides the payment — the enquiry's
  // canonical `amountPaise` does that below.
  const reportedPaise = rupeesToPaise(paid_amount ?? request_amount);
  if (reportedPaise !== null) {
    let expected = null;
    try { expected = toPaise(order.total); } catch { /* caught by invariants */ }
    if (expected !== null && reportedPaise !== expected)
      console.warn("[sabpaisa webhook] reported amount differs from order total for", orderId);
  }

  // Verified and identity-matched. Forward only now, stamped as verified.
  forwardToKkchat({ ...body, stage: "webhook" }, { verified: true });

  // Safe webhook metadata. The signature and the raw payload are not persisted.
  const receivedAt = new Date().toISOString();
  order.sabpaisaWebhookVerified   = true;
  order.sabpaisaWebhookReceivedAt = receivedAt;
  order.sabpaisaWebhookStatus     = status ? String(status) : null;
  order.sabpaisaWebhookEvent      = event ? String(event) : null;
  order.updatedAt                 = receivedAt;

  // ── Authority step ────────────────────────────────────────────────────────
  // An authenticated webhook is NOT sufficient: `event === "payment.success"`
  // never settles an order by itself. SabPaisa's own record decides, queried by
  // the SERVER-stored reference. This also means a webhook reporting failure
  // while the enquiry reports SUCCESS settles as paid — the enquiry wins.
  const reconciled = await reconcileSabpaisaOrder(order, gatewayTxnId);

  if (reconciled.outcome === "unavailable") {
    // 503 so SabPaisa retries; the authoritative state is left untouched.
    console.warn("[sabpaisa webhook] enquiry unavailable for", orderId, reconciled.reason || "");
    return res.status(503).json({ error: "Verification temporarily unavailable." });
  }
  if (reconciled.outcome === "not_found") {
    console.warn("[sabpaisa webhook] enquiry: transaction not found for", orderId);
    return res.status(200).json({ received: true, status: order.status });
  }
  if (reconciled.outcome === "mismatch") {
    console.warn("[sabpaisa webhook] reconciliation mismatch:", reconciled.reason, "for", orderId);
    return res.status(400).json({ error: "Verification mismatch" });
  }

  console.log("[sabpaisa webhook] reconciled:", { orderId, status: reconciled.status });
  return res.status(200).json({ received: true, status: reconciled.status });
});

// ── PayU Hosted Checkout ─────────────────────────────────────────────────────
// Trust boundary: the frontend sends only an orderId. The amount, txnid,
// productinfo and hash are all derived server-side from the stored order.
//
// Status authority: the browser callback below can only ever record that PayU's
// return LOOKS authentic. It must never move an order to "paid" — that requires
// the S2S webhook / Verify Payment API reconciliation (Task 4).

/**
 * Invariants shared by the browser callback and the S2S webhook. Both receive a
 * cryptographically verified PayU payload; both must still prove it belongs to
 * THIS order and THIS attempt before anything is recorded.
 *
 * @returns {string|null} the name of the first failing invariant, or null.
 */
function payuOrderMismatch(order, payload) {
  if (order.gateway !== "payu") return "gateway";
  if (String(payload.txnid) !== String(order.payuTxnId || "")) return "txnid";
  if (String(payload.udf1) !== String(order.id)) return "udf1";
  if (String(payload.key) !== String(payuPublicConfig().key)) return "key";
  if (String(payload.productinfo) !== buildProductInfo(order.id)) return "productinfo";

  // Amount is compared against the trusted order total, nothing else.
  let expected;
  try {
    expected = formatPayUAmount(order.total);
  } catch {
    return "order_total";
  }
  let received;
  try {
    received = formatPayUAmount(payload.amount);
  } catch {
    received = null;
  }
  if (received !== expected) return "amount";

  return null;
}

const payuOrderRedirect = (orderId, returnStatus) => {
  const url = `${FRONTEND_ORDER_BASE}/order/${encodeURIComponent(orderId)}` +
    `?status=pending&gateway=payu`;
  return returnStatus ? `${url}&returnStatus=${encodeURIComponent(returnStatus)}` : url;
};

router.post("/payu/initiate", (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== "string")
    return res.status(400).json({ error: "orderId required." });

  if (!payuConfigured()) {
    console.error("[payu initiate] PayU production configuration unavailable");
    return res.status(503).json({ error: "PayU is unavailable." });
  }

  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "paid")
    return res.status(409).json({ error: "Order already paid." });

  let checkout;
  try {
    // Derives amount from order.total, generates txnid/productinfo/hash.
    checkout = buildPayUCheckout(order);
  } catch (err) {
    // Adapter errors are deliberately credential-free ("PayU buyer email missing").
    console.error("[payu initiate]", orderId, err.message);
    return res.status(400).json({ error: err.message });
  }

  // Attempt metadata only — never the hash, key or salt.
  const now = new Date().toISOString();
  order.gateway            = "payu";
  order.payuTxnId          = checkout.fields.txnid;
  order.paymentAttemptedAt = now;
  order.updatedAt          = now;
  order.status             = "pending"; // authoritative state until Task 4

  // Returned verbatim: altering any hashed field would invalidate the request.
  res.json(checkout);
});

// Browser return from Hosted Checkout. POST only — see the GET handler below.
router.post("/payu/callback", (req, res) => {
  const payload = req.body || {};

  if (!payuConfigured()) {
    console.error("[payu callback] PayU production configuration unavailable");
    return res.status(503).json({ error: "PayU is unavailable." });
  }

  const required = [
    "hash", "status", "txnid", "amount", "key",
    "productinfo", "firstname", "email", "udf1",
  ];
  for (const field of required) {
    const v = payload[field];
    if (v === undefined || v === null || String(v).trim() === "") {
      console.warn("[payu callback] rejected: incomplete payload");
      return res.status(400).json({ error: "Invalid PayU response" });
    }
  }

  // Nothing in the payload is trusted until the reverse hash verifies.
  let hashOk = false;
  try {
    hashOk = verifyPayUResponseHash(payload);
  } catch (err) {
    console.error("[payu callback] verification error:", err.message);
    return res.status(503).json({ error: "PayU is unavailable." });
  }
  if (!hashOk) {
    console.warn("[payu callback] rejected: reverse hash verification failed");
    return res.status(400).json({ error: "Invalid PayU response" });
  }

  const orderId = String(payload.udf1).trim();
  const order   = orders.get(orderId);
  if (!order) {
    // Legitimate after a restart: the store is in memory. Log the id only.
    console.warn("[payu callback] order not in memory:", orderId);
    return res.status(404).json({ error: "Order not found." });
  }

  // Every invariant is checked explicitly, even where it looks implied.
  const mismatch = payuOrderMismatch(order, payload);
  if (mismatch) {
    console.warn("[payu callback] rejected:", mismatch, "mismatch for", orderId);
    return res.status(400).json({ error: "Invalid PayU response" });
  }

  // Verified. Record the return only — the status below is UX information,
  // not a payment decision. Re-delivery of the same return is idempotent.
  const now = new Date().toISOString();
  order.payuReturnVerified  = true;
  order.payuReturnStatus    = String(payload.status);
  order.payuUnmappedStatus  = payload.unmappedstatus ? String(payload.unmappedstatus) : null;
  order.payuMihpayid        = payload.mihpayid ? String(payload.mihpayid) : null;
  order.payuMode            = payload.mode ? String(payload.mode) : null;
  order.payuReturnedAt      = now;
  order.updatedAt           = now;
  // The webhook + Verify Payment path owns the final transition. If it has
  // already settled this order, the browser return must not undo it.
  if (order.status !== "paid" && order.status !== "failed") order.status = "pending";

  const returnStatus =
    String(payload.status).toLowerCase() === "success" ? "success" : "failure";
  console.log("[payu callback] verified return:", {
    orderId, returnStatus, hashOk: true,
  });

  res.redirect(payuOrderRedirect(order.id, returnStatus));
});

// Server-to-server webhook — the ONLY path that may settle a PayU order, and
// only after PayU's own Verify Payment API independently confirms the payment.
// Register as: <PUBLIC_BASE_URL>/api/payment/payu/webhook
//
// Pipeline: reverse hash → order invariants → Verify Payment API → final state.
// JSON or urlencoded both arrive here already parsed by server.js.
router.post("/payu/webhook", async (req, res) => {
  const payload = req.body || {};

  if (!payuConfigured()) {
    console.error("[payu webhook] PayU production configuration unavailable");
    return res.status(503).json({ error: "PayU is unavailable." });
  }

  // Cryptography first: an unverified body must never reach the Verify Payment
  // API, or this endpoint becomes a transaction-lookup oracle for attackers.
  let hashOk = false;
  try {
    hashOk = verifyPayUResponseHash(payload);
  } catch (err) {
    console.error("[payu webhook] verification error:", err.message);
    return res.status(503).json({ error: "PayU is unavailable." });
  }
  if (!hashOk) {
    console.warn("[payu webhook] rejected: reverse hash verification failed");
    return res.status(400).json({ error: "Invalid PayU webhook" });
  }

  const orderId = payload.udf1 === undefined || payload.udf1 === null
    ? "" : String(payload.udf1).trim();
  if (!orderId) {
    console.warn("[payu webhook] rejected: udf1 missing");
    return res.status(400).json({ error: "Invalid PayU webhook" });
  }

  const order = orders.get(orderId);
  if (!order) {
    console.warn("[payu webhook] order not in memory:", orderId);
    return res.status(404).json({ error: "Order not found." });
  }

  const mismatch = payuOrderMismatch(order, payload);
  if (mismatch) {
    console.warn("[payu webhook] rejected:", mismatch, "mismatch for", orderId);
    return res.status(400).json({ error: "Invalid PayU webhook" });
  }

  // Safe webhook metadata. The webhook's own status is never the decision.
  const receivedAt = new Date().toISOString();
  order.payuWebhookVerified       = true;
  order.payuWebhookReceivedAt     = receivedAt;
  order.payuWebhookStatus         = String(payload.status).toLowerCase();
  order.payuWebhookUnmappedStatus = payload.unmappedstatus
    ? String(payload.unmappedstatus).toLowerCase() : null;
  order.payuWebhookMihpayid       = payload.mihpayid ? String(payload.mihpayid) : null;
  order.updatedAt                 = receivedAt;

  // Authority step. Always the SERVER-stored txnid, never a request value.
  const verified = await verifyPayUPayment(order.payuTxnId);

  if (!verified.ok) {
    // Transport/parse failure: the order's authoritative status is untouched so
    // that a PayU retry can reconcile it later.
    console.warn("[payu webhook] verify unavailable for", orderId, verified.reason);
    return res.status(503).json({ error: "Verification temporarily unavailable." });
  }

  if (!verified.found) {
    // Eventual consistency, not a failure. Never downgrade to "failed".
    console.warn("[payu webhook] verify: transaction not found for", orderId);
    return res.status(200).json({ received: true, status: order.status });
  }

  // Reconcile PayU's own record against the trusted order before deciding.
  let expectedAmount;
  try {
    expectedAmount = formatPayUAmount(order.total);
  } catch {
    expectedAmount = null;
  }
  let verifiedAmount = null;
  if (verified.amount !== null && verified.amount !== undefined) {
    try {
      verifiedAmount = formatPayUAmount(verified.amount);
    } catch {
      verifiedAmount = null;
    }
  }

  const vMismatch =
    String(verified.txnid || "") !== String(order.payuTxnId || "") ? "txnid"
    // A missing amt fails closed: no amount, no authorization.
    : expectedAmount === null || verifiedAmount === null || verifiedAmount !== expectedAmount ? "amount"
    : String(verified.udf1 || "") !== String(order.id) ? "udf1"
    : String(verified.productinfo || "") !== buildProductInfo(order.id) ? "productinfo"
    // Compared only when PayU gave us both; one missing value is not a conflict.
    : (verified.mihpayid && order.payuWebhookMihpayid &&
       verified.mihpayid !== order.payuWebhookMihpayid) ? "mihpayid"
    : null;

  if (vMismatch) {
    console.warn("[payu webhook] verify reconciliation mismatch:", vMismatch, "for", orderId);
    return res.status(400).json({ error: "Verification mismatch" });
  }

  // Idempotency / cross-transaction safety: a settled order may only ever be
  // re-confirmed by the same stored transaction, which the txnid check above
  // already guarantees. Re-confirming must not re-run any business effect.
  const alreadyPaid = order.status === "paid";
  const settled     = verified.paymentStatus === "success" && verified.unmappedStatus === "captured";

  const now = new Date().toISOString();

  if (settled) {
    if (!alreadyPaid) {
      // Legitimate pending→paid, and failed→paid when PayU's record for this
      // same txnid later captured.
      order.status = "paid";
      order.paidAt = now;
    }
    order.payuVerified               = true;
    order.payuVerifiedAt             = now;
    order.payuVerifiedStatus         = verified.paymentStatus;
    order.payuVerifiedUnmappedStatus = verified.unmappedStatus;
    order.payuVerifiedAmount         = verifiedAmount;
    order.payuMihpayid               = verified.mihpayid || order.payuMihpayid || null;
    order.payuMode                   = verified.mode || order.payuMode || null;
    order.payuBankRefNum             = verified.bankRefNum || null;
    order.updatedAt                  = now;
    console.log("[payu webhook] reconciled:", { orderId, status: "paid" });
    return res.status(200).json({ received: true, status: "paid" });
  }

  // Not success+captured. Record the verification, but never regress a payment
  // PayU already confirmed as captured for this transaction.
  order.payuVerified               = true;
  order.payuVerifiedAt             = now;
  order.payuVerifiedStatus         = verified.paymentStatus;
  order.payuVerifiedUnmappedStatus = verified.unmappedStatus;
  order.updatedAt                  = now;

  if (alreadyPaid) {
    console.warn("[payu webhook] verify no longer captured for a paid order:", orderId);
    return res.status(200).json({ received: true, status: "paid" });
  }

  if (verified.paymentStatus === "failure" || verified.paymentStatus === "failed") {
    order.status = "failed"; // no paidAt on failure
    console.log("[payu webhook] reconciled:", { orderId, status: "failed" });
    return res.status(200).json({ received: true, status: "failed" });
  }

  // pending / initiated / in progress / success-but-not-captured / anything
  // unrecognized: do not guess.
  order.status = "pending";
  console.log("[payu webhook] reconciled:", { orderId, status: "pending" });
  return res.status(200).json({ received: true, status: "pending" });
});

// PayU returns via POST. A GET here must never touch payment state.
router.get("/payu/callback", (_req, res) => {
  res.set("Allow", "POST").status(405).json({ error: "Method Not Allowed" });
});

export default router;
