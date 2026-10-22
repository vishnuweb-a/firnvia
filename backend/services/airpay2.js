// AirPay v4 — SECOND merchant ("AirPay 2").
//
// Same "Simple Transaction" protocol as services/airpay.js (OAuth2 token ->
// encrypted transaction form -> hosted gateway -> callback), but every function
// here takes an explicit merchant config instead of reading module-level env.
// services/airpay.js is intentionally left untouched: its credentials are bound
// at import time, and changing that module would change the original gateway.
//
// Credentials come ONLY from the *_2 variables below. There is no fallback to
// the original AIRPAY_* merchant — a missing *_2 value is a configuration
// error, never a reason to borrow merchant 1's credentials.
//
// Crypto primitives (identical to services/airpay.js, per docs.airpay.co.in/v4):
//   encryptionKey = md5(username + "~:~" + password)         [AES-256-CBC key]
//   encrypt(json) = ivHex(16) + base64( AES-256-CBC(json) )  [PKCS7 padding]
//   decrypt(resp) = AES-256-CBC( base64(resp[16:]) , iv=resp[0:16] )
//   checksum(obj) = sha256( <values sorted by key, concatenated> + YYYY-MM-DD(IST) )
//   privatekey    = sha256( secret + "@" + username + ":|:" + password )
//   ap_SecureHash = crc32( orderid:apTxnId:amount:txnStatus:message:mid:username[:vpa] )
//
// ap_SecureHash is CRC32 — an integrity checksum, NOT authentication. It is
// linear and forgeable, so a matching hash only filters garbage. Payment
// authority comes from the Verify API (verifyTransaction), queried server-side.

import crypto from "crypto";
import axios from "axios";
import CRC32 from "crc-32";

export const AIRPAY2_GATEWAY = "airpay_2";

const DEFAULT_OAUTH_URL  = "https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/";
const DEFAULT_PAY_URL    = "https://payments.airpay.co.in/pay/v4/";
// docs.airpay.co.in/v4/payments/order-confirmation — "will work only on live MID".
const DEFAULT_VERIFY_URL = "https://kraken.airpay.co.in/airpay/pay/v4/api/verify/";

const HTTP_TIMEOUT_MS = 10000;

// Env var name -> config key. Names only; values are never logged or returned.
const REQUIRED_ENV = {
  merchantId:   "AIRPAY_MID_2",
  username:     "AIRPAY_USERNAME_2",
  password:     "AIRPAY_PASSWORD_2",
  secret:       "AIRPAY_API_KEY_2",      // the merchant "API key" = privatekey secret
  clientId:     "AIRPAY_CLIENT_ID_2",
  clientSecret: "AIRPAY_CLIENT_SECRET_2",
};

const env = (name) => (process.env[name] || "").trim();

// Read per call (not at import) so the two merchants stay independently
// configurable and tests can swap credentials without re-importing.
export function airpay2Config() {
  const cfg = {};
  for (const [key, name] of Object.entries(REQUIRED_ENV)) cfg[key] = env(name);
  cfg.encryptionKey = env("AIRPAY_ENCRYPTION_KEY_2"); // optional, as for merchant 1
  cfg.oauthUrl  = env("AIRPAY_OAUTH_URL_2")  || DEFAULT_OAUTH_URL;
  cfg.payUrl    = env("AIRPAY_PAY_URL_2")    || DEFAULT_PAY_URL;
  cfg.verifyUrl = env("AIRPAY_VERIFY_URL_2") || DEFAULT_VERIFY_URL;
  return cfg;
}

/** Names of required *_2 variables that are unset. Never their values. */
export function airpay2MissingConfig(cfg = airpay2Config()) {
  return Object.entries(REQUIRED_ENV)
    .filter(([key]) => !cfg[key])
    .map(([, name]) => name);
}

export const airpay2Configured = (cfg = airpay2Config()) =>
  airpay2MissingConfig(cfg).length === 0;

// ── Crypto (config-parameterized mirror of services/airpay.js) ─────────────

function encryptionKey(cfg) {
  if (cfg.encryptionKey) return cfg.encryptionKey;
  return crypto.createHash("md5").update(`${cfg.username}~:~${cfg.password}`).digest("hex");
}

function istDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function encrypt(cfg, plain) {
  const key = Buffer.from(encryptionKey(cfg), "utf8");
  const ivStr = crypto.randomBytes(8).toString("hex");
  const cipher = crypto.createCipheriv("aes-256-cbc", key, Buffer.from(ivStr, "utf8"));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
  return ivStr + enc;
}

function decrypt(cfg, payload) {
  const key = Buffer.from(encryptionKey(cfg), "utf8");
  const ivStr = payload.slice(0, 16);
  const enc = payload.slice(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(ivStr, "utf8"));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

function checksum(obj) {
  const concatenated = Object.keys(obj).sort().map((k) => obj[k]).join("");
  return crypto.createHash("sha256").update(concatenated + istDate()).digest("hex");
}

function privatekey(cfg) {
  return crypto
    .createHash("sha256")
    .update(`${cfg.secret}@${cfg.username}:|:${cfg.password}`)
    .digest("hex");
}

// AirPay API responses arrive either as { response: "<encrypted>" }, as a bare
// encrypted string, or as plain JSON. Same tolerance as services/airpay.js.
function parseApiResponse(cfg, data) {
  if (data && typeof data === "object" && typeof data.response === "string")
    return JSON.parse(decrypt(cfg, data.response));
  if (typeof data === "string") {
    try { return JSON.parse(decrypt(cfg, data)); } catch { return JSON.parse(data); }
  }
  return data;
}

// Form body shared by the OAuth and Verify calls.
function signedForm(cfg, data, { withPrivateKey = false } = {}) {
  const form = {
    merchant_id: cfg.merchantId,
    encdata: encrypt(cfg, JSON.stringify(data)),
    checksum: checksum(data),
  };
  if (withPrivateKey) form.privatekey = privatekey(cfg);
  return new URLSearchParams(form).toString();
}

// ── Step 1: OAuth2 access token ────────────────────────────────────────────
export async function getAccessToken(cfg = airpay2Config()) {
  const data = {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    merchant_id: cfg.merchantId,
    grant_type: "client_credentials",
  };
  const res = await axios.post(cfg.oauthUrl, signedForm(cfg, data), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: HTTP_TIMEOUT_MS,
  });
  const parsed = parseApiResponse(cfg, res.data);
  const token = parsed?.data?.access_token || parsed?.access_token;
  // Deliberately no response body in the message: it may echo merchant data.
  if (!token) throw new Error("AirPay 2 OAuth failed: no access token returned");
  return token;
}

// ── Step 2: hosted checkout form ───────────────────────────────────────────
// Buyer, amount and currency handling match services/airpay.js exactly.
export async function buildCheckoutForm(order, buyer, cfg = airpay2Config()) {
  const token = await getAccessToken(cfg);

  const [firstName, ...rest] = (buyer.firstName || "Customer").trim().split(" ");
  const data = {
    buyer_email: buyer.email,
    buyer_phone: String(buyer.phone),
    buyer_firstname: firstName || "Customer",
    buyer_lastname: buyer.lastName || rest.join(" ") || "NA",
    amount: order.total.toFixed(2),
    orderid: order.id,
    currency_code: "356",
    iso_currency: "INR",
  };

  return {
    action: `${cfg.payUrl}?token=${encodeURIComponent(token)}`,
    method: "POST",
    fields: {
      privatekey: privatekey(cfg),
      merchant_id: cfg.merchantId,
      encdata: encrypt(cfg, JSON.stringify(data)),
      checksum: checksum(data),
    },
  };
}

// ── Step 3: callback / IPN integrity check ─────────────────────────────────

const str = (v) => (v === undefined || v === null ? "" : String(v));

function pick(b, ...names) {
  for (const n of names) if (b[n] !== undefined && b[n] !== null && b[n] !== "") return str(b[n]);
  return "";
}

/** Canonical "1234.50" form of an amount, or null when it is not an amount. */
export function normalizeAmount(v) {
  const s = str(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s).toFixed(2);
}

/** Pull the fields this integration relies on from a callback or verify record. */
export function extractTxnFields(body) {
  return {
    orderid:       pick(body, "orderid", "TRANSACTIONID"),
    apTxnId:       pick(body, "ap_transactionid", "APTRANSACTIONID"),
    amount:        pick(body, "amount", "AMOUNT"),
    txnStatus:     pick(body, "transaction_status", "TRANSACTIONSTATUS"),
    paymentStatus: pick(body, "transaction_payment_status", "TRANSACTIONPAYMENTSTATUS"),
    message:       pick(body, "message", "MESSAGE"),
    merchantId:    pick(body, "merchant_id", "MERCHANTID", "MERCID", "mercid"),
    currencyCode:  pick(body, "currency_code", "CURRENCYCODE"),
    chmod:         pick(body, "chmod", "CHMOD"),
    customerVpa:   pick(body, "customer_vpa", "CUSTOMERVPA"),
    secureHash:    pick(body, "ap_SecureHash", "ap_securehash", "AP_SECUREHASH"),
  };
}

/**
 * Validate a callback/IPN payload for merchant 2.
 *
 * @returns {{ok:boolean, reason?:string, fields:object}}
 *   reason: "incomplete" | "merchant_id" | "hash"
 */
export function verifyCallback(body, cfg = airpay2Config()) {
  const f = extractTxnFields(body || {});

  for (const k of ["orderid", "apTxnId", "amount", "txnStatus", "secureHash"])
    if (!f[k].trim()) return { ok: false, reason: "incomplete", fields: f };

  // The hash binds MID anyway; an explicit, different merchant_id is rejected
  // up front so merchant-1 (or anyone else's) callbacks never get further.
  if (f.merchantId && f.merchantId !== cfg.merchantId)
    return { ok: false, reason: "merchant_id", fields: f };

  const base = [f.orderid, f.apTxnId, f.amount, f.txnStatus, f.message,
                cfg.merchantId, cfg.username].join(":");
  // UPI transactions append the customer VPA (docs: simple-transaction).
  const candidates = [base];
  if (f.customerVpa) candidates.push(`${base}:${f.customerVpa}`);

  const received = f.secureHash.trim();
  const ok = candidates.some((input) => (CRC32.str(input) >>> 0).toString() === received);
  return ok ? { ok: true, fields: f } : { ok: false, reason: "hash", fields: f };
}

/**
 * Map an AirPay transaction_status (+ payment status) to a local outcome.
 * Codes from docs.airpay.co.in/v4: 200 success, 211 processing, 400 failed,
 * 401 not registered, 402 not yet processed, 403 no bank callback,
 * 405 bounced, 503 no records.
 *
 * @returns {"paid"|"failed"|"pending"|"not_found"|"unknown"}
 */
export function classifyStatus(txnStatus, paymentStatus = "") {
  const code = str(txnStatus).trim();
  const ps = str(paymentStatus).trim().toUpperCase();
  if (code === "200") return !ps || ps === "SUCCESS" ? "paid" : "pending";
  if (["211", "402", "403"].includes(code)) return "pending";
  if (["400", "401", "405"].includes(code)) return "failed";
  if (code === "503") return "not_found";
  return "unknown";
}

// ── Step 4: server-side Verify API (order confirmation) ────────────────────

/**
 * Ask AirPay for its own record of a transaction. Never throws.
 *
 * @returns {Promise<
 *   {ok:false, reason:string} |
 *   {ok:true, found:false} |
 *   {ok:true, found:true, outcome:string, fields:object}
 * >}
 */
export async function verifyTransaction({ orderid, apTxnId }, cfg = airpay2Config()) {
  if (!orderid && !apTxnId) return { ok: false, reason: "no_reference" };
  try {
    const token = await getAccessToken(cfg);
    const data = {};
    if (orderid) data.orderid = String(orderid);
    if (apTxnId) data.ap_transactionid = String(apTxnId);

    const url = `${cfg.verifyUrl}?token=${encodeURIComponent(token)}`;
    const res = await axios.post(url, signedForm(cfg, data, { withPrivateKey: true }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: HTTP_TIMEOUT_MS,
    });

    const parsed = parseApiResponse(cfg, res.data);
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: "unparseable" };

    // HTTP 200 is returned even for logical errors: the body decides.
    const record = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? parsed.data : null;
    if (str(parsed.status_code) !== "200" || !record) {
      if (record && str(record.transaction_status) === "503") return { ok: true, found: false };
      return { ok: false, reason: `api_status_${str(parsed.status_code) || "unknown"}` };
    }

    const fields = extractTxnFields(record);
    const outcome = classifyStatus(fields.txnStatus, fields.paymentStatus);
    if (outcome === "not_found") return { ok: true, found: false };
    return { ok: true, found: true, outcome, fields };
  } catch (err) {
    // Timeouts and network errors. Message only — never the request body.
    const reason = err?.code === "ECONNABORTED" ? "timeout" : "network";
    return { ok: false, reason };
  }
}

export const _internals = { encrypt, decrypt, checksum, privatekey, encryptionKey, istDate };
