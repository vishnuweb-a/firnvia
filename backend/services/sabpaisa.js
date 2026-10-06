// SabPaisa PG 3.0 REST integration (Task 5A-Retry).
//
// PROTOCOL: SabPaisa PG 3.0 REST API — JSON over HTTPS, `X-Api-Key` auth,
// HMAC-SHA256 checksums, hosted checkout by redirect, S2S webhooks and a
// server-side Transaction Enquiry API. Production endpoints:
//
//   payment  POST https://merchant-api.sabpaisa.in/api/v2/payments
//   enquiry  POST https://merchant-api.sabpaisa.in/api/v2/payments/enquiry
//
// This is NOT the older securepay.sabpaisa.in encData/authKey/authIV AES form
// integration; that is a different SabPaisa integration generation and must not
// be mixed in here.
//
// AUTHORITY MODEL (unchanged in spirit from Task 5A, now completable):
// neither the browser return nor the signed webhook settles a payment on its
// own. Both are authentication steps; the Transaction Enquiry API is the
// authoritative source of status and of the canonical `amountPaise`. The
// browser return is UX only.

import crypto from "crypto";
import axios from "axios";

const cfg = {
  clientCode:     process.env.SABPAISA_CLIENT_CODE     || "",
  apiKey:         process.env.SABPAISA_API_KEY         || "",
  secretKey:      process.env.SABPAISA_SECRET_KEY      || "",
  webhookSecret:  process.env.SABPAISA_WEBHOOK_SECRET  || "",
  enquiryUrl:     process.env.SABPAISA_ENQUIRY_URL     || "",
  payUrl:         process.env.SABPAISA_PAY_URL         || "https://merchant-api.sabpaisa.in/api/v2/payments",
};

/** Credentials needed to START a payment. */
export const sabpaisaConfigured = () =>
  Boolean(cfg.clientCode && cfg.apiKey && cfg.secretKey);

/**
 * Credentials needed to VERIFY a server-to-server webhook. Separate from the
 * above on purpose: initiating without a webhook secret is survivable, but
 * accepting a webhook without one is not.
 */
export const sabpaisaWebhookConfigured = () => Boolean(cfg.webhookSecret);

/**
 * Whether the Transaction Enquiry endpoint is configured for this deployment.
 *
 * The URL is read from configuration rather than hardcoded so a non-production
 * deployment can point elsewhere; production is
 * https://merchant-api.sabpaisa.in/api/v2/payments/enquiry.
 */
export function enquiryProtocolStatus() {
  return cfg.enquiryUrl ? "configured" : "not_configured";
}
export const sabpaisaEnquiryConfigured = () => enquiryProtocolStatus() === "configured";

/** Amount unit on the wire: paise (integer). Rupee 1 => 100. */
export const SABPAISA_AMOUNT_UNIT = "paise";

/**
 * Convert a trusted rupee order total to the integer paise the gateway expects.
 * Throws rather than silently coercing — a bad amount must never reach a hash.
 */
export function toPaise(rupees) {
  const n = typeof rupees === "number" ? rupees : Number(rupees);
  if (!Number.isFinite(n) || n <= 0) throw new Error("SabPaisa amount invalid");
  const paise = Math.round(n * 100);
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new Error("SabPaisa amount invalid");
  return paise;
}

/**
 * Convert a RUPEE amount as reported on the return URL to integer paise.
 * Returns null — never a guess — when absent or unparseable.
 */
export function rupeesToPaise(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === "" || !/^\d+(\.\d+)?$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  if (!Number.isSafeInteger(paise) || paise <= 0) return null;
  return paise;
}

function checksum(merchantId, merchantTxnId, amount, currency, timestamp) {
  if (!cfg.secretKey) throw new Error("SabPaisa secret key unavailable");
  const raw = `${merchantId}|${merchantTxnId}|${amount}|${currency}|${timestamp}`;
  return crypto.createHmac("sha256", cfg.secretKey).update(raw).digest("hex");
}

/** Unix seconds, as PG 3.0 payment creation expects. */
export const unixSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Start a payment for a trusted, server-stored order.
 *
 * The amount is derived from `order.total` only. No caller-supplied amount is
 * accepted or consulted; the route layer never forwards one.
 */
export async function initiatePayment(order, buyer = {}) {
  if (!sabpaisaConfigured()) throw new Error("SabPaisa is not configured");

  const timestamp   = unixSeconds();         // PG 3.0: Unix SECONDS
  const amountValue = toPaise(order.total);  // trusted order total, in paise
  const currency    = "INR";
  const hash = checksum(cfg.clientCode, order.id, String(amountValue), currency, String(timestamp));

  const payload = {
    merchantId:    cfg.clientCode,
    merchantTxnId: order.id,
    amount:        amountValue,
    currency,
    customerName:  `${buyer.firstName || ""} ${buyer.lastName || ""}`.trim() || "Customer",
    customerEmail: buyer.email,
    customerPhone: String(buyer.phone ?? ""),
    returnUrl:     `${process.env.PUBLIC_BASE_URL}/api/payment/sabpaisa/callback`,
    checksum:      hash,
    timestamp,
  };

  // Never log the payload: it carries the checksum and customer contact data.
  console.log("[sabpaisa initiate] requesting checkout for", order.id);

  let res;
  try {
    res = await axios.post(cfg.payUrl, payload, {
      headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json" },
      timeout: 15000,
    });
  } catch (err) {
    // Status only — a provider error body can echo request fields back.
    console.error("[sabpaisa initiate] HTTP", err.response?.status);
    throw new Error(`SabPaisa request failed (${err.response?.status || "network error"})`);
  }

  const checkoutUrl  = res.data?.checkoutUrl  || res.data?.data?.checkoutUrl;
  const clientSecret = res.data?.clientSecret || res.data?.data?.clientSecret;
  const d = res.data?.data && typeof res.data.data === "object" ? res.data.data : (res.data || {});
  const gatewayTxnId = res.data?.txnId || res.data?.transactionId || d.txnId || d.transactionId || null;
  const paymentId    = res.data?.sessionId || res.data?.paymentId || d.sessionId || d.paymentId || null;
  const expiresAt    = res.data?.expiresAt || d.expiresAt || d.sessionExpiresAt || null;
  if (!checkoutUrl) throw new Error("SabPaisa did not return a checkoutUrl");

  const redirectUrl = clientSecret
    ? `${checkoutUrl}?clientSecret=${encodeURIComponent(clientSecret)}`
    : checkoutUrl;

  // clientSecret is embedded in the redirect URL the customer must follow; it is
  // never returned as a separate field, stored, or logged.
  return {
    checkoutUrl:   redirectUrl,
    amount:        amountValue,
    merchantTxnId: order.id,
    gatewayTxnId:  gatewayTxnId ? String(gatewayTxnId) : null,
    paymentId:     paymentId ? String(paymentId) : null,
    expiresAt:     expiresAt ? String(expiresAt) : null,
  };
}

/**
 * Verify the X-SabPaisa-Signature header on an incoming webhook.
 * Header format: "{timestamp}.{base64_hmac_sha256}"
 * Signed string: timestamp + "." + rawBody  (exact bytes — never re-serialized)
 *
 * FAILS CLOSED. With no configured secret there is no way to tell a genuine
 * webhook from a forged one, so the webhook is rejected rather than trusted.
 */
export function verifyWebhookSignature(signatureHeader, rawBody) {
  if (!cfg.webhookSecret) return { ok: false, reason: "webhook secret not configured" };
  if (!signatureHeader)   return { ok: false, reason: "missing signature header" };
  if (!rawBody || !rawBody.length) return { ok: false, reason: "missing raw body" };

  const header = String(signatureHeader);
  const dot = header.indexOf(".");
  if (dot === -1) return { ok: false, reason: "malformed signature header" };

  const timestamp   = header.slice(0, dot);
  const receivedSig = header.slice(dot + 1);
  if (!/^\d+$/.test(timestamp) || !receivedSig)
    return { ok: false, reason: "malformed signature header" };

  // Reject replays outside a 5-minute window.
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000)
    return { ok: false, reason: "timestamp outside accepted window" };

  const toSign   = `${timestamp}.${rawBody.toString()}`;
  const expected = crypto.createHmac("sha256", cfg.webhookSecret).update(toSign).digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(receivedSig);
  if (a.length !== b.length) return { ok: false, reason: "signature mismatch" };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/**
 * Build the PG 3.0 return-URL signature base string.
 *
 * 1. take every received parameter except `signature`
 * 2. sort the parameter NAMES alphabetically
 * 3. join as  key=value|key=value|...
 *
 * Exported for tests; the value is never logged (it echoes customer fields).
 */
export function buildReturnSignatureBase(params = {}) {
  return Object.keys(params)
    .filter((k) => k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k] === undefined || params[k] === null ? "" : params[k]}`)
    .join("|");
}

/**
 * Verify a PG 3.0 return-URL (browser redirect) payload.
 *
 * Algorithm: HMAC-SHA256 over the sorted `key=value|...` base string above,
 * keyed with SABPAISA_SECRET_KEY, compared as lowercase hex in constant time.
 *
 * Return-URL amount semantics: `amount` and `paid_amount` are RUPEES, and the
 * return timestamp is in MILLISECONDS. Neither is used to authorize anything —
 * the canonical amount comes from the enquiry API's `amountPaise`.
 *
 * `ok:true` means only "this payload carries a signature our secret
 * reproduces". It never authorizes settlement: `paid` is advisory UX state.
 *
 * FAILS CLOSED on a missing secret, a missing signature/reference, or any
 * mismatch.
 */
export function verifyCallback(body = {}) {
  const params  = body && typeof body === "object" ? body : {};
  const orderId = params.merchant_txn_id || params.merchantTxnId || null;
  const txnId   = params.transaction_id || params.txn_id || params.sabpaisaTxnId || null;
  const status  = params.status || params.txnStatus || "";
  const received = params.signature || null;

  // Return-URL amounts are rupees. Kept only for non-authoritative reporting.
  const rupees = params.paid_amount ?? params.amount ?? null;

  const base = {
    ok: false, paid: false, reason: null,
    orderid: orderId,
    txnId: txnId ? String(txnId) : null,
    amountPaise: rupeesToPaise(rupees),
    statusText: String(status),
  };

  if (!cfg.secretKey) return { ...base, reason: "secret not configured" };
  if (!orderId)       return { ...base, reason: "missing merchant txn id" };
  if (!received)      return { ...base, reason: "missing signature" };

  const expected = crypto
    .createHmac("sha256", cfg.secretKey)
    .update(buildReturnSignatureBase(params))
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(received).toLowerCase());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ...base, reason: "signature mismatch" };

  const paid = String(status).toUpperCase() === "SUCCESS";
  return { ...base, ok: true, paid, reason: null };
}

const ENQUIRY_TIMEOUT_MS = 9000;

/** PG 3.0 enquiry status values this adapter recognizes. */
const SUCCESS_STATUSES  = new Set(["SUCCESS"]);
const FAILED_STATUSES   = new Set(["FAILED", "FAILURE"]);
const PENDING_STATUSES  = new Set(["PENDING", "PROCESSING", "INITIATED"]);
const TERMINAL_STATUSES = new Set(["EXPIRED", "CANCELLED", "CANCELED", "TIMEOUT", "ABORTED"]);

/**
 * Classify an enquiry status into the order model's vocabulary.
 *
 * The order model supports only `pending | paid | failed`, so the terminal
 * non-success states (EXPIRED, CANCELLED, TIMEOUT, ABORTED) are mapped to
 * `failed` — they are not retryable for THIS attempt; the customer starts a new
 * attempt, which creates a new merchantTxnId. An unrecognized status maps to
 * `unknown`, and callers must leave the order state untouched.
 *
 * @returns {"paid"|"failed"|"pending"|"unknown"}
 */
export function classifyEnquiryStatus(statusText) {
  const s = String(statusText ?? "").trim().toUpperCase();
  if (!s) return "unknown";
  if (SUCCESS_STATUSES.has(s))  return "paid";
  if (FAILED_STATUSES.has(s))   return "failed";
  if (PENDING_STATUSES.has(s))  return "pending";
  if (TERMINAL_STATUSES.has(s)) return "failed";
  return "unknown";
}

/** Parse a canonical integer-paise field. Returns null when absent/invalid. */
function parsePaise(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === "" || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * SabPaisa PG 3.0 Transaction Enquiry — the authoritative status source and the
 * analogue of PayU's Verify Payment layer.
 *
 *   POST  SABPAISA_ENQUIRY_URL           (prod: /api/v2/payments/enquiry)
 *   head  X-Api-Key, Content-Type: application/json
 *   body  { clientCode, merchantTxnId }
 *
 * The secret key and webhook secret are NEVER sent as request fields.
 *
 * @param {string} merchantTxnId a reference this server generated and stored.
 *                               Never a value taken from a request body.
 * @returns {Promise<object>} normalized result:
 *   { ok:true, found:true, merchantTxnId, txnId, paymentId, status, outcome,
 *     amountPaise, currency, paymentMode, bankTxnId, bankRrn, completedAt }
 *   { ok:true, found:false }
 *   { ok:false, reason:"<code>" }
 *
 * Never throws for network conditions, never returns customer PII, the raw
 * provider body, or credentials.
 */
export async function enquireTransaction(merchantTxnId) {
  if (!sabpaisaConfigured())        return { ok: false, reason: "sabpaisa_not_configured" };
  if (!sabpaisaEnquiryConfigured()) return { ok: false, reason: "enquiry_not_configured" };

  const id = merchantTxnId === undefined || merchantTxnId === null ? "" : String(merchantTxnId).trim();
  if (!id) return { ok: false, reason: "txn_id_missing" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENQUIRY_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(cfg.enquiryUrl, {
      method: "POST",
      headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ clientCode: cfg.clientCode, merchantTxnId: id }),
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 404 = SabPaisa has no such transaction. Not a failure, and never success.
    if (response.status === 404) return { ok: true, found: false };
    return { ok: false, reason: "http_error" };
  }

  let parsed;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "invalid_response" };

  // Responses may be flat or wrapped in `data`.
  const d = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;

  if (parsed.success === false || d.success === false) return { ok: true, found: false };

  const returnedId = d.merchantTxnId || d.merchant_txn_id || null;
  if (!returnedId) return { ok: true, found: false };

  const statusText = String(d.status ?? d.txnStatus ?? "");
  const txnId = d.txnId || d.transaction_id || d.transactionId || null;

  return {
    ok: true,
    found: true,
    merchantTxnId: String(returnedId),
    txnId:     txnId ? String(txnId) : null,
    paymentId: d.sessionId ? String(d.sessionId) : null,
    status:    statusText,
    outcome:   classifyEnquiryStatus(statusText),
    // Canonical integer paise. Deliberately NOT falling back to requestAmount /
    // paidAmount: those are rupee representations and must not authorize.
    amountPaise: parsePaise(d.amountPaise ?? d.amount_paise),
    currency:    d.currency ? String(d.currency) : null,
    paymentMode: d.paymentMode || d.payment_mode ? String(d.paymentMode ?? d.payment_mode) : null,
    bankTxnId:   d.bankTxnId || d.bank_txn_id ? String(d.bankTxnId ?? d.bank_txn_id) : null,
    bankRrn:     d.bankRrn || d.bank_rrn ? String(d.bankRrn ?? d.bank_rrn) : null,
    completedAt: d.completedAt || d.completed_at ? String(d.completedAt ?? d.completed_at) : null,
  };
}
