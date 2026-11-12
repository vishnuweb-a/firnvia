// HDFC SmartGateway — Payment Page integration, Basic Authentication kit.
//
// Contract (smartgateway.hdfc.bank.in/docs, "SmartGateway API Reference (Basic Auth)"):
//   POST {BASE_URL}/session          create order + hosted payment page link
//   GET  {BASE_URL}/orders/:order_id Order Status API — the ONLY payment authority
//   Authorization: "Basic " + base64(API_KEY); headers x-merchantid, x-customerid,
//   x-resellerid: hdfc_reseller.
//   Return URL carries order_id/status/status_id + signature (HMAC-SHA256,
//   RESPONSE_KEY, base64) — authenticity only; status is re-read server-side.
//   Webhooks authenticate with dashboard-configured Basic username/password.
//
// UPI-only is enforced with HDFC's documented payment locking ("UPI: Display
// only UPI"): payment_filter { allowDefaultOptions:false, options:[UPI] }, sent
// on every session. A CHARGED order paid by any other method type is flagged.
//
// Every function reads config per call so tests and env changes take effect
// without re-importing. Secrets are never logged or returned.

import crypto from "crypto";
import axios from "axios";

export const HDFC_GATEWAY = "hdfc";

const HTTP_TIMEOUT_MS = 10000;
const RESELLER_ID = "hdfc_reseller";
// Documented hosts per environment; a mismatch would send production keys to UAT.
const ENV_HOSTS = {
  production: "smartgateway.hdfc.bank.in",
  sandbox: "smartgateway.hdfcuat.bank.in",
};
export const UPI_ONLY_PAYMENT_FILTER = Object.freeze({
  allowDefaultOptions: false,
  options: [{ paymentMethodType: "UPI", enable: true }],
});

const env = (name) => (process.env[name] || "").trim();
const REQUIRED_ENV = {
  merchantId:          "HDFC_SMARTGATEWAY_MERCHANT_ID",
  paymentPageClientId: "HDFC_SMARTGATEWAY_PAYMENT_PAGE_CLIENT_ID",
  apiKey:              "HDFC_SMARTGATEWAY_API_KEY",
  responseKey:         "HDFC_SMARTGATEWAY_RESPONSE_KEY",
  baseUrl:             "HDFC_SMARTGATEWAY_BASE_URL",
  returnUrl:           "HDFC_SMARTGATEWAY_RETURN_URL",
};

export function hdfcConfig() {
  const cfg = {};
  for (const [key, name] of Object.entries(REQUIRED_ENV)) cfg[key] = env(name);
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  cfg.env = env("HDFC_SMARTGATEWAY_ENV").toLowerCase();
  cfg.enabled = env("HDFC_SMARTGATEWAY_ENABLED").toLowerCase() === "true";
  cfg.upiOnly = env("HDFC_SMARTGATEWAY_UPI_ONLY").toLowerCase() === "true";
  cfg.logging = env("HDFC_SMARTGATEWAY_ENABLE_LOGGING").toLowerCase() === "true";
  cfg.webhookUsername = env("HDFC_SMARTGATEWAY_WEBHOOK_USERNAME");
  cfg.webhookPassword = env("HDFC_SMARTGATEWAY_WEBHOOK_PASSWORD");
  return cfg;
}

/**
 * Problems that make the API credentials unusable. Variable NAMES only.
 * Needed for ANY HDFC call — including late returns/webhooks/reconciliation.
 */
export function hdfcMissingConfig(cfg = hdfcConfig()) {
  const missing = Object.entries(REQUIRED_ENV).filter(([k]) => !cfg[k]).map(([, n]) => n);
  if (!ENV_HOSTS[cfg.env]) missing.push("HDFC_SMARTGATEWAY_ENV (production|sandbox)");
  else if (cfg.baseUrl) {
    let host = null;
    try { const u = new URL(cfg.baseUrl); if (u.protocol === "https:") host = u.host; } catch { /* invalid */ }
    if (host !== ENV_HOSTS[cfg.env]) missing.push("HDFC_SMARTGATEWAY_BASE_URL (must match HDFC_SMARTGATEWAY_ENV)");
  }
  if (cfg.returnUrl) {
    // Docs: https, no query parameters.
    let ok = false;
    try { const u = new URL(cfg.returnUrl); ok = u.protocol === "https:" && !u.search; } catch { /* invalid */ }
    if (!ok) missing.push("HDFC_SMARTGATEWAY_RETURN_URL (https, no query string)");
  }
  return missing;
}

/** Can a NEW checkout be started? Flag + complete config + UPI-only. */
export function hdfcInitiationBlockers(cfg = hdfcConfig()) {
  const blockers = hdfcMissingConfig(cfg);
  if (!cfg.enabled) blockers.unshift("HDFC_SMARTGATEWAY_ENABLED");
  if (!cfg.upiOnly) blockers.push("HDFC_SMARTGATEWAY_UPI_ONLY");
  return blockers;
}
export const hdfcAvailable = (cfg = hdfcConfig()) => hdfcInitiationBlockers(cfg).length === 0;
export const hdfcWebhookConfigured = (cfg = hdfcConfig()) =>
  Boolean(cfg.webhookUsername && cfg.webhookPassword);

// ── HTTP ────────────────────────────────────────────────────────────────────

function headers(cfg, customerId) {
  return {
    Authorization: "Basic " + Buffer.from(cfg.apiKey).toString("base64"),
    "Content-Type": "application/json",
    "x-merchantid": cfg.merchantId,
    "x-customerid": customerId,
    "x-resellerid": RESELLER_ID,
  };
}

function failureReason(err) {
  if (err?.code === "ECONNABORTED") return "timeout";
  if (err?.response) return `http_${err.response.status}`;
  return "network";
}

/** Order ids: alphanumeric, < 21 chars, non-sequential (session API docs). */
export function newHdfcOrderId() {
  return "FIR" + crypto.randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 15).padEnd(15, "0");
}

// Stable, non-PII customer reference (needed by x-customerid / customer_id).
export const hdfcCustomerId = (email) =>
  "c" + crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 19);

const nameSafe = (s) => String(s || "").replace(/[^A-Za-z0-9 ().\-_]/g, "").trim().slice(0, 50);

/** 10-digit Indian mobile, or null. */
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : null;
}

/** "849.00" from an order total, or null. */
export function formatHdfcAmount(total) {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  return total.toFixed(2);
}
/** Canonical "849.00" from an Order Status amount (number or string), or null. */
export function normalizeHdfcAmount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null;
}

/**
 * Create the HDFC order + payment page link. The amount comes from the stored
 * order only; the caller passes nothing that could influence it.
 * @returns {Promise<{hdfcOrderId, amount, customerId, checkoutUrl, providerOrderRef}>}
 */
export async function createSession(order, cfg = hdfcConfig()) {
  const amount = formatHdfcAmount(order.total);
  if (!amount) throw new HdfcInputError("Order total is invalid.");
  const buyer = order.buyer || {};
  const email = String(buyer.email || "").trim();
  if (!email) throw new HdfcInputError("Buyer email missing.");
  const phone = normalizePhone(buyer.phone);
  if (!phone) throw new HdfcInputError("A valid 10-digit mobile number is required.");

  const [first, ...rest] = nameSafe(buyer.firstName).split(/\s+/);
  const hdfcOrderId = newHdfcOrderId();
  const customerId = hdfcCustomerId(email);
  const body = {
    order_id: hdfcOrderId,
    amount,
    currency: "INR",
    customer_id: customerId,
    customer_email: email,
    customer_phone: phone,
    payment_page_client_id: cfg.paymentPageClientId,
    action: "paymentPage",
    return_url: cfg.returnUrl,
    description: "Firvanra order payment",
    first_name: first || "Customer",
    last_name: nameSafe(buyer.lastName) || rest.join(" ") || "NA",
    payment_filter: UPI_ONLY_PAYMENT_FILTER,
  };

  let res;
  try {
    res = await axios.post(`${cfg.baseUrl}/session`, body, {
      headers: headers(cfg, customerId), timeout: HTTP_TIMEOUT_MS,
    });
  } catch (err) {
    if (cfg.logging) console.warn("[hdfc session] failed:", failureReason(err), err?.response?.data?.error_code || "");
    throw new Error(`HDFC session failed: ${failureReason(err)}`);
  }

  const data = res.data || {};
  const link = data.payment_links?.web;
  if (String(data.order_id || "") !== hdfcOrderId) throw new Error("HDFC session failed: order_id mismatch");
  // Only ever send the customer to HDFC's own host.
  let linkOk = false;
  try { const u = new URL(link); linkOk = u.protocol === "https:" && u.host === new URL(cfg.baseUrl).host; } catch { /* invalid */ }
  if (!linkOk) throw new Error("HDFC session failed: unexpected payment link");

  return { hdfcOrderId, amount, customerId, checkoutUrl: link, providerOrderRef: data.id ? String(data.id) : null };
}

export class HdfcInputError extends Error {}

/**
 * HDFC's own record of an order. Never throws.
 * @returns {Promise<{ok:false, reason:string} | {ok:true, found:false} | {ok:true, found:true, record:object}>}
 */
export async function getOrderStatus(hdfcOrderId, customerId, cfg = hdfcConfig()) {
  if (!hdfcOrderId) return { ok: false, reason: "no_reference" };
  try {
    const res = await axios.get(`${cfg.baseUrl}/orders/${encodeURIComponent(hdfcOrderId)}`, {
      headers: headers(cfg, customerId || ""), timeout: HTTP_TIMEOUT_MS,
    });
    const record = res.data;
    if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, reason: "unparseable" };
    return { ok: true, found: true, record };
  } catch (err) {
    if (err?.response?.status === 404) return { ok: true, found: false };
    if (cfg.logging) console.warn("[hdfc status] failed:", failureReason(err));
    return { ok: false, reason: failureReason(err) };
  }
}

// ── Return URL signature ────────────────────────────────────────────────────

/**
 * HMAC-SHA256 return-URL check, exactly as HDFC's Node/PHP/.NET kits compute
 * it: params minus signature/signature_algorithm, sorted by key, "k=v" joined
 * by "&", URL-encoded as a whole, HMAC with RESPONSE_KEY, base64.
 */
export function verifyReturnSignature(params, responseKey) {
  if (!params || typeof params !== "object" || !responseKey) return false;
  const sig = params.signature;
  if (typeof sig !== "string" || !sig) return false;
  const algo = params.signature_algorithm;
  if (algo !== undefined && String(algo).toUpperCase() !== "HMAC-SHA256") return false;

  const keys = Object.keys(params).filter((k) => k !== "signature" && k !== "signature_algorithm");
  // Kits join raw k=v; the Juspay HMAC doc percent-encodes each key and value
  // first. Identical for plain values; accept either so a legitimate return
  // with special characters isn't rejected. Both still require RESPONSE_KEY.
  const kit = keys.sort().map((k) => `${k}=${params[k]}`).join("&");
  const doc = keys
    .map((k) => [encodeURIComponent(k), encodeURIComponent(String(params[k]))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  let received;
  try { received = Buffer.from(decodeURIComponent(sig)); } catch { return false; }
  return [kit, doc].some((str) => {
    const computed = Buffer.from(crypto.createHmac("sha256", responseKey).update(encodeURIComponent(str)).digest("base64"));
    return computed.length === received.length && crypto.timingSafeEqual(computed, received);
  });
}

/** Webhook Basic auth against the dashboard-configured username/password. */
export function verifyWebhookAuth(authorization, cfg = hdfcConfig()) {
  if (!hdfcWebhookConfigured(cfg)) return false;
  const m = /^Basic\s+(.+)$/i.exec(String(authorization || "").trim());
  if (!m) return false;
  const got = Buffer.from(Buffer.from(m[1], "base64").toString("utf8"));
  const want = Buffer.from(`${cfg.webhookUsername}:${cfg.webhookPassword}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── Status mapping + settlement ─────────────────────────────────────────────

// Transaction Status table (kits docs, resources/transaction-status).
const PAID = new Set(["CHARGED"]);
const FAILED = new Set(["AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "JUSPAY_DECLINED", "AUTO_REFUNDED"]);
const PENDING = new Set(["NEW", "STARTED", "PENDING", "PENDING_VBV", "AUTHORIZING"]);

/** @returns {"paid"|"failed"|"pending"|"unknown"} */
export function classifyHdfcStatus(status) {
  const s = String(status || "").trim().toUpperCase();
  if (PAID.has(s)) return "paid";
  if (FAILED.has(s)) return "failed";
  if (PENDING.has(s)) return "pending";
  return "unknown"; // AUTHORIZED/VOID*/CAPTURE*: not used (auto-capture) — don't guess
}

/**
 * Apply HDFC's Order Status record to one attempt of a local order.
 * Pure state transition on `order` — no I/O. Idempotent.
 *
 * Invariants before "paid": order_id === attempt id, merchant_id matches,
 * amount === attempt amount === order total, currency INR, status CHARGED.
 * A paid order is never downgraded; a second CHARGED attempt is flagged.
 *
 * @returns {{outcome:"paid"|"failed"|"pending"|"unknown"|"mismatch", reason?:string, status:string}}
 */
export function applyHdfcStatus(order, attempt, record, cfg = hdfcConfig()) {
  const now = new Date().toISOString();
  if (String(record.order_id || "") !== attempt.hdfcOrderId)
    return { outcome: "mismatch", reason: "order_id", status: order.status };
  if (record.merchant_id && String(record.merchant_id) !== cfg.merchantId)
    return { outcome: "mismatch", reason: "merchant_id", status: order.status };

  const outcome = classifyHdfcStatus(record.status);
  attempt.providerStatus = String(record.status || "");
  attempt.providerStatusId = record.status_id ?? null;
  attempt.paymentMethodType = record.payment_method_type ? String(record.payment_method_type) : attempt.paymentMethodType || null;
  attempt.txnId = record.txn_id ? String(record.txn_id) : attempt.txnId || null;
  attempt.verifiedAt = now;
  order.updatedAt = now;

  if (outcome === "paid") {
    const amount = normalizeHdfcAmount(record.amount);
    const effective = record.effective_amount === undefined ? amount : normalizeHdfcAmount(record.effective_amount);
    const expected = formatHdfcAmount(order.total);
    if (!amount || amount !== attempt.amount || amount !== expected || effective !== amount)
      return { outcome: "mismatch", reason: "amount", status: order.status };
    if (String(record.currency || "").toUpperCase() !== "INR")
      return { outcome: "mismatch", reason: "currency", status: order.status };

    attempt.verified = true;
    attempt.verifiedAmount = amount;
    if (attempt.paymentMethodType !== "UPI") {
      // Payment locking should make this impossible; money was still taken.
      attempt.nonUpiPayment = true;
      console.warn("[hdfc] CHARGED with non-UPI method type for", order.id);
    }
    if (order.status === "paid") {
      if (order.hdfcPaidOrderId && order.hdfcPaidOrderId !== attempt.hdfcOrderId) {
        attempt.duplicateCharge = true; // second successful attempt: refund review
        console.warn("[hdfc] duplicate charge on already-paid order", order.id);
      }
      return { outcome: "paid", status: "paid" };
    }
    order.status = "paid";
    order.paidAt = now;
    order.paidAmount = amount;
    order.hdfcPaidOrderId = attempt.hdfcOrderId;
    order.hdfcTxnId = attempt.txnId;
    return { outcome: "paid", status: "paid" };
  }

  // Late/duplicate failures never downgrade a verified payment.
  if (order.status === "paid") return { outcome, status: "paid" };
  // Only the latest attempt decides the order's open state.
  const latest = order.hdfcAttempts?.[order.hdfcAttempts.length - 1];
  if (latest !== attempt) return { outcome, status: order.status };
  if (outcome === "failed") order.status = "failed";
  else if (outcome === "pending") order.status = "pending";
  return { outcome, status: order.status };
}

/**
 * Query HDFC for one attempt and apply the result.
 * @returns {Promise<{outcome:string, reason?:string, status:string}>}
 *   outcome adds "unavailable" | "not_found" | "not_configured".
 */
export async function reconcileHdfcAttempt(order, attempt, cfg = hdfcConfig()) {
  if (hdfcMissingConfig(cfg).length) return { outcome: "not_configured", status: order.status };
  attempt.lastCheckedAt = Date.now();
  const res = await getOrderStatus(attempt.hdfcOrderId, attempt.customerId, cfg);
  if (!res.ok) return { outcome: "unavailable", reason: res.reason, status: order.status };
  if (!res.found) return { outcome: "not_found", status: order.status };
  const applied = applyHdfcStatus(order, attempt, res.record, cfg);
  if (applied.outcome === "mismatch")
    console.warn("[hdfc reconcile] mismatch:", applied.reason, "for", order.id);
  return applied;
}

const REFRESH_MIN_INTERVAL_MS = 10000;

/**
 * Called when the order page polls: a pending HDFC order is re-checked against
 * the Order Status API (throttled) so delayed results settle without a webhook.
 */
export async function refreshHdfcOrder(order, cfg = hdfcConfig()) {
  if (order?.gateway !== HDFC_GATEWAY || order.status !== "pending") return;
  const attempt = order.hdfcAttempts?.[order.hdfcAttempts.length - 1];
  if (!attempt || Date.now() - (attempt.lastCheckedAt || 0) < REFRESH_MIN_INTERVAL_MS) return;
  try { await reconcileHdfcAttempt(order, attempt, cfg); }
  catch (err) { console.warn("[hdfc refresh] failed for", order.id, err.message); }
}
