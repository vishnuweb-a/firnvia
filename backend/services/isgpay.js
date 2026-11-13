// ISGPay NG — Redirection, non-PCI ("ISGPay (UAT)"). UAT DEMO, NOT PRODUCTION-READY.
//
// Contract: ISGPay_NG_Redirection_NonPCI_Compliant_API_Specifications_v1.6.pdf.
// The YesBankPG Node kit is used only to settle details the PDF leaves open
// (empty-field handling, AES key/mode, field order). Its bugs are not copied.
//
//   Sale:    browser form POST {MerchantId, TerminalId, BankId, EncData} to ISGPAY_SALE_URL.
//            EncData = Base64(AES-256-ECB(key = 32 UTF-8 bytes of ISGPAY_ENC_KEY, PKCS#7),
//                      "Name||value::Name||value::...::SecureHash||<hex>").
//   Hash:    hex(SHA-256(SECURE_SECRET + values sorted by name, ASCII ascending)),
//            SecureHash itself excluded; empty/absent fields left out (kit behaviour).
//            Plain SHA-256 of the concatenation — NOT HMAC.
//   Return / push callback: same envelope back, decrypted and hash-verified here.
//   Status:  signed TxnType=Status request to ISGPAY_STATUS_URL; ResponseCode "00" = success.
//
// Provenance of each behaviour:
//   PROVIDER-CONFIRMED (v1.6 PDF): HTTP POST only; outer {MerchantId, TerminalId, BankId, EncData};
//     EncData "Name||value::…"; SHA-256 hash rule + §4 example; field names/casing in §3.1/§3.2/§3.6;
//     UAT paths /ISGPay-Genius/request.action and /ISGPay-Genius/Status; ResponseCode "00" = success;
//     callback reposted up to 3× / 30 min without a response code.
//   LEGACY-KIT COMPATIBILITY (YesBankPG Node kit, not in the PDF): AES-256-ECB/PKCS#7 with the key's
//     raw UTF-8 bytes; empty fields dropped from hash and EncData; sorted EncData order; hash also
//     tried over once-URL-decoded values; "k=v&k=v" status response; optional Version field.
//   UNCONFIRMED ASSUMPTIONS (neither source settles them): status REQUEST encoding (we send a
//     form-urlencoded body; the kit sends a query string with an empty body); status RESPONSE wire
//     format/decoding; push-callback acknowledgement encoding (JSON placeholder); whether Version
//     is required. An empty status body is reported as inconclusive, never as success.
//
// Version: explicit. ISGPAY_VERSION unset → no Version field anywhere (v1.6 tables list none).
// Set (the kit uses "1") → sent in the sale EncData (hashed), the outer sale form, and the status
// request. Never switched or retried automatically: a second sale could double-charge.
//
// Status authority: only a hash-verified Sale Status response moves an order.
// The browser return and push callback are verified triggers for that query.
// Config is read per call; secrets are never logged or returned.

import crypto from "crypto";
import axios from "axios";

export const ISGPAY_GATEWAY = "isgpay";

const env = (name) => (process.env[name] || "").trim();
const REQUIRED_ENV = {
  bankId:       "ISGPAY_BANK_ID",
  merchantId:   "ISGPAY_MERCHANT_ID",
  terminalId:   "ISGPAY_TERMINAL_ID",
  mcc:          "ISGPAY_MCC",
  passCode:     "ISGPAY_PASS_CODE",      // API field PassCode (spreadsheet: ACCESS_CODE)
  secureSecret: "ISGPAY_SECURE_SECRET",
  encKey:       "ISGPAY_ENC_KEY",
  saleUrl:      "ISGPAY_SALE_URL",
  statusUrl:    "ISGPAY_STATUS_URL",
  returnUrl:    "ISGPAY_RETURN_URL",
  currency:     "ISGPAY_CURRENCY",
};
const HTTPS_URLS = ["saleUrl", "statusUrl", "returnUrl"];

export function isgpayConfig() {
  // Identifiers stay strings: BankId "000004" must keep its leading zeros.
  const cfg = {};
  for (const [key, name] of Object.entries(REQUIRED_ENV)) cfg[key] = env(name);
  cfg.env = env("ISGPAY_ENV").toLowerCase();
  cfg.enabled = env("ISGPAY_ENABLED").toLowerCase() === "true"; // "false", "", "1" → off
  cfg.callbackUrl = env("ISGPAY_CALLBACK_URL");
  cfg.payOpt = env("ISGPAY_PAY_OPT");
  cfg.acceptablePaymentModes = env("ISGPAY_ACCEPTABLE_PAYMENT_MODES");
  cfg.version = env("ISGPAY_VERSION"); // "" = omit; see header
  // ISGPAY_REFUND_URL / ISGPAY_REFUND_STATUS_URL: reserved for future refund work.
  return cfg;
}

const isHttps = (v) => { try { return new URL(v).protocol === "https:"; } catch { return false; } };

/** Problems that make the credentials unusable. Variable NAMES only, never values. */
export function isgpayMissingConfig(cfg = isgpayConfig()) {
  const missing = Object.entries(REQUIRED_ENV).filter(([k]) => !cfg[k]).map(([, n]) => n);
  // Only UAT is supported by this integration.
  if (cfg.env !== "uat") missing.push("ISGPAY_ENV (uat)");
  if (cfg.encKey && Buffer.byteLength(cfg.encKey, "utf8") !== 32) missing.push("ISGPAY_ENC_KEY (32 bytes)");
  if (cfg.currency && cfg.currency !== "356") missing.push("ISGPAY_CURRENCY (356)");
  if (cfg.bankId && !/^[A-Za-z0-9]{6}$/.test(cfg.bankId)) missing.push("ISGPAY_BANK_ID");
  if (cfg.merchantId && !/^[A-Za-z0-9]{1,16}$/.test(cfg.merchantId)) missing.push("ISGPAY_MERCHANT_ID");
  if (cfg.terminalId && !/^[A-Za-z0-9]{1,8}$/.test(cfg.terminalId)) missing.push("ISGPAY_TERMINAL_ID");
  for (const k of HTTPS_URLS) if (cfg[k] && !isHttps(cfg[k])) missing.push(`${REQUIRED_ENV[k]} (https)`);
  if (cfg.version && !/^\d{1,2}$/.test(cfg.version)) missing.push("ISGPAY_VERSION (numeric)");
  return missing;
}

// ── Diagnostics ────────────────────────────────────────────────────────────
// Sanitized only: field NAMES, lengths, results, references, amounts, codes.
// Never secrets, PassCode, EncData content, or customer details.

export const isgpayLog = (event, data) => console.log(`[isgpay ${event}]`, JSON.stringify(data));
export const pathOf = (u) => { try { return new URL(u).pathname; } catch { return "(invalid)"; } };
const names = (o) => (o && typeof o === "object" ? Object.keys(o).slice(0, 60).map((k) => k.slice(0, 40)) : []);
const short = (v, n = 80) => (v === undefined || v === null ? null : String(v).slice(0, n));

/** Can a NEW checkout start? Flag + complete config. Returns/callbacks don't need the flag. */
export function isgpayInitiationBlockers(cfg = isgpayConfig()) {
  const blockers = isgpayMissingConfig(cfg);
  if (!cfg.enabled) blockers.unshift("ISGPAY_ENABLED");
  return blockers;
}
export const isgpayAvailable = (cfg = isgpayConfig()) => isgpayInitiationBlockers(cfg).length === 0;

// ── Amount ─────────────────────────────────────────────────────────────────

/** INR rupees (number) → integer paise string. 199 → "19900". null if invalid. */
export function toPaise(total) {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  const [r, p] = total.toFixed(2).split("."); // string split avoids 1.15*100 = 114.999…
  const paise = Number(r) * 100 + Number(p);
  return Number.isSafeInteger(paise) && paise > 0 ? String(paise) : null;
}

// ── Signature ──────────────────────────────────────────────────────────────

const present = (v) => v !== undefined && v !== null && v !== ""; // "0" is a real value

/** hex(SHA-256(secret + values in ASCII-ascending name order)). SecureHash and empties excluded. */
export function secureHash(fields, secret) {
  const names = Object.keys(fields).filter((k) => k !== "SecureHash" && present(fields[k]));
  // Default sort compares UTF-16 code units = ASCII order for these names ('Card' < 'CardNum' < 'card').
  names.sort();
  return crypto.createHash("sha256").update(secret + names.map((k) => String(fields[k])).join(""), "utf8").digest("hex");
}

function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !/^[0-9a-fA-F]{64}$/.test(a) || !/^[0-9a-fA-F]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a.toLowerCase()), Buffer.from(b.toLowerCase()));
}

/**
 * Verify a received SecureHash over the received fields, exactly as received.
 * Fallback: the kit verifies over values URL-decoded once ('+' as space); accept
 * that variant too, since the PDF does not say which form ISGPay hashes. Both
 * still require the secret.
 */
export const verifySecureHash = (fields, secret) => secureHashMatch(fields, secret) !== null;

/** Which form matched: "raw" (PDF), "url_decoded" (kit), or null. Diagnostics only. */
export function secureHashMatch(fields, secret) {
  if (!fields || !secret) return null;
  const got = fields.SecureHash;
  if (hexEqual(secureHash(fields, secret), got)) return "raw";
  const decoded = {};
  for (const [k, v] of Object.entries(fields)) {
    try { decoded[k] = decodeURIComponent(String(v).replace(/\+/g, "%20")); } catch { return null; }
  }
  return hexEqual(secureHash(decoded, secret), got) ? "url_decoded" : null;
}

// ── EncData ────────────────────────────────────────────────────────────────

export class IsgpayInputError extends Error {}

const DELIMS = /\|\||::/;

/** "Name||value::Other||value" — sorted, SecureHash last (kit order). Rejects delimiter-bearing values. */
export function serializeEncData(fields) {
  const names = Object.keys(fields).filter((k) => k !== "SecureHash" && present(fields[k])).sort();
  if (present(fields.SecureHash)) names.push("SecureHash");
  return names.map((k) => {
    const v = String(fields[k]);
    // No escaping is documented, so a value containing a delimiter cannot be sent safely.
    if (DELIMS.test(k) || DELIMS.test(v) || v.endsWith("|") || v.endsWith(":") || k.endsWith("|"))
      throw new IsgpayInputError(`Field ${k} contains a reserved delimiter.`);
    return `${k}||${v}`;
  }).join("::");
}

/** Parse "Name||value::..." without altering names or values. Throws on malformed/duplicate. */
export function parseEncData(plain) {
  if (typeof plain !== "string" || !plain.includes("||")) throw new Error("malformed");
  const out = Object.create(null);
  for (const seg of plain.split("::")) {
    if (seg === "") continue; // tolerate a trailing "::"
    const i = seg.indexOf("||");
    if (i <= 0) throw new Error("malformed");
    const k = seg.slice(0, i);
    if (k in out) throw new Error("duplicate field");
    out[k] = seg.slice(i + 2);
  }
  return out;
}

const keyBytes = (encKey) => {
  const key = Buffer.from(encKey, "utf8"); // literal UTF-8 bytes, not hex-decoded
  if (key.length !== 32) throw new Error("ISGPAY_ENC_KEY must be 32 bytes");
  return key;
};

/** AES-256-ECB, PKCS#7, Base64 — as the supplied kit's Utility.js. ECB has no IV. */
export function encryptAes(plain, encKey) {
  const c = crypto.createCipheriv("aes-256-ecb", keyBytes(encKey), null);
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}
export function decryptAes(b64, encKey) {
  const d = crypto.createDecipheriv("aes-256-ecb", keyBytes(encKey), null);
  return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
}

/** Sign + serialize + encrypt a request field set. */
export function buildEncData(fields, cfg) {
  const signed = { ...fields, SecureHash: secureHash(fields, cfg.secureSecret) };
  return encryptAes(serializeEncData(signed), cfg.encKey);
}

/**
 * Decrypt and verify a posted {MerchantId, TerminalId, BankId, EncData} envelope
 * (browser return or push callback). Pure; never throws. `trace` is sanitized
 * (names, lengths, check results) for diagnostics.
 * @returns {{ok:true, fields:object, trace} | {ok:false, reason:string, trace}}
 */
export function openEnvelope(body, cfg = isgpayConfig()) {
  const trace = { receivedFields: names(body), decrypt: "not_run", signature: "not_checked" };
  const fail = (reason) => ({ ok: false, reason, trace });
  if (!body || typeof body !== "object") return fail("no_body");
  const { MerchantId, TerminalId, BankId } = body;
  let enc = body.EncData;
  if (typeof enc !== "string" || !enc) return fail("no_encdata");
  // Base64 never contains spaces: a space is a '+' that arrived un-percent-encoded.
  enc = enc.replace(/ /g, "+");
  trace.encDataLength = enc.length;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(enc) || enc.length % 4) return fail("encdata_format");
  trace.outerIdentity = String(MerchantId) === cfg.merchantId && String(TerminalId) === cfg.terminalId &&
    String(BankId) === cfg.bankId ? "match" : "mismatch";
  if (trace.outerIdentity !== "match") return fail("outer_identity");
  let fields;
  try { fields = parseEncData(decryptAes(enc, cfg.encKey)); trace.decrypt = "ok"; }
  catch { trace.decrypt = "failed"; return fail("decrypt_or_parse"); }
  trace.decryptedFields = names(fields);
  const sig = secureHashMatch(fields, cfg.secureSecret);
  trace.signature = sig || "invalid";
  if (!sig) return fail("hash");
  trace.innerIdentity = fields.MerchantId === cfg.merchantId && fields.TerminalId === cfg.terminalId &&
    fields.BankId === cfg.bankId ? "match" : "mismatch";
  if (trace.innerIdentity !== "match") return fail("inner_identity");
  if (!fields.TxnRefNo) return fail("no_txnrefno");
  return { ok: true, fields, trace };
}

/** Check a verified envelope against the saved attempt. null = consistent. */
export function envelopeMismatch(fields, attempt) {
  if (fields.TxnRefNo !== attempt.txnRefNo) return "txnrefno";
  // Amount is Optional in the response table: compared whenever present.
  if (present(fields.Amount) && fields.Amount !== attempt.amount) return "amount";
  if (present(fields.Currency) && fields.Currency !== attempt.currency) return "currency";
  return null;
}

// ── Sale request ───────────────────────────────────────────────────────────

/** Unique attempt reference: alphanumeric, ≤ 40 chars, non-guessable (it is also the status-route id). */
export const newTxnRefNo = () =>
  "ISG" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(8).toString("hex").toUpperCase();

const clean = (s, re, n) => String(s || "").replace(re, "").trim().slice(0, n);

/** 10-digit Indian mobile, or null. */
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : null;
}

/**
 * Build the sale form for a stored order. Amount comes from the stored order only.
 * @returns {{attempt:object, form:{action, method, fields}}}
 */
export function buildSaleRequest(order, cfg = isgpayConfig()) {
  const amount = toPaise(order.total);
  if (!amount) throw new IsgpayInputError("Order total is invalid.");
  const txnRefNo = newTxnRefNo();
  const buyer = order.buyer || {};
  const email = String(buyer.email || "").trim();

  const fields = {
    BankId: cfg.bankId,
    MerchantId: cfg.merchantId,
    TerminalId: cfg.terminalId,
    TxnRefNo: txnRefNo,
    MCC: cfg.mcc,
    PassCode: cfg.passCode,
    TxnType: "Pay",
    Command: "Pay",
    Currency: cfg.currency,
    Amount: amount,
    ReturnURL: cfg.returnUrl,
    OrderInfo: clean(order.id, /[^A-Za-z0-9]/g, 40),       // links back to the Firvanra order
    FirstName: clean(buyer.firstName, /[^A-Za-z ]/g, 30),
    Email: email.length <= 100 && /^[^\s|:]+@[^\s|:]+$/.test(email) ? email : "",
    Phone: normalizePhone(buyer.phone) || "",
    payOpt: cfg.payOpt,                                    // e.g. "upi"
    AcceptablePaymentModes: cfg.acceptablePaymentModes,   // e.g. "upi"
    Version: cfg.version,                                  // explicit opt-in; "" is omitted
  };
  // No CardNumber / ExpiryDate / CardSecurityCode: hosted redirection only.

  const outer = { MerchantId: cfg.merchantId, TerminalId: cfg.terminalId, BankId: cfg.bankId,
    EncData: buildEncData(fields, cfg) };
  if (cfg.version) outer.Version = cfg.version; // kit sends it outside EncData too
  return {
    attempt: { txnRefNo, amount, currency: cfg.currency, providerStatus: "NEW", verified: false,
      createdAt: new Date().toISOString() },
    form: { action: cfg.saleUrl, method: "POST", fields: outer },
    // Sanitized: names only, same order the hash uses (+ SecureHash).
    encFieldNames: [...Object.keys(fields).filter((k) => present(fields[k])).sort(), "SecureHash"],
  };
}

// ── Push-callback acknowledgement ─────────────────────────────────────────

/**
 * Body returned to ISGPay's push callback (PDF §3.6.2 field list).
 * PROVIDER CONFIRMATION NEEDED: the PDF names the fields but not the encoding
 * (JSON / form / pipe). JSON is a placeholder; change it only here.
 */
export const isgpayAcknowledgement = (cfg = isgpayConfig()) => ({
  contentType: "application/json",
  body: JSON.stringify({ MerchantId: cfg.merchantId, TerminalId: cfg.terminalId, BankId: cfg.bankId,
    Acknowledgement: "Received" }),
});

// ── Sale Status Query ─────────────────────────────────────────────────────

const STATUS_TIMEOUT_MS = 8000;
const STATUS_TRIES = 2;

function failureReason(err) {
  if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") return "timeout";
  if (err?.response) return `http_${err.response.status}`;
  return "network";
}

/** Diagnostic label for a status body. Detection only: "json"/"html"/"other" are never parsed. */
export function detectStatusFormat(text) {
  const b = String(text ?? "").trim();
  if (!b) return "empty";
  if (b.startsWith("<")) return "html";
  if (b.startsWith("{") || b.startsWith("[")) return "json";
  if (b.includes("||")) return "pipe";
  if (b.includes("=")) return /(^|&)EncData=/.test(b) ? "kv_encdata" : "kv";
  return "other";
}

const responseShape = (res) => {
  const text = typeof res?.data === "string" ? res.data : String(res?.data ?? "");
  return { httpStatus: res?.status ?? null, contentType: short(res?.headers?.["content-type"]),
    bytes: Buffer.byteLength(text, "utf8"), format: detectStatusFormat(text) };
};

/**
 * Parse a status response body. The PDF lists the fields but not the wire
 * format; the kit reads "k=v&k=v". A pipe-delimited body, or a body carrying
 * only EncData, is handled too. Throws on anything else.
 */
export function parseStatusBody(text, cfg) {
  const body = String(text ?? "").trim();
  if (body.includes("||")) return parseEncData(body);
  if (!body.includes("=")) throw new Error("unparseable");
  const out = Object.create(null);
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error("unparseable");
    const k = pair.slice(0, i);
    if (k in out) throw new Error("duplicate field");
    out[k] = pair.slice(i + 1); // raw; verifySecureHash tries the once-decoded form too
  }
  if (out.EncData && !out.TxnRefNo) {
    let enc;
    try { enc = decodeURIComponent(out.EncData); } catch { enc = out.EncData; }
    return parseEncData(decryptAes(enc.replace(/ /g, "+"), cfg.encKey));
  }
  return out;
}

/**
 * Query ISGPay for one TxnRefNo. Bounded: STATUS_TRIES × STATUS_TIMEOUT_MS. Never throws.
 * @returns {Promise<{ok:false, reason:string} | {ok:true, record:object}>}
 */
export async function querySaleStatus(txnRefNo, cfg = isgpayConfig()) {
  const fields = {
    BankId: cfg.bankId, MerchantId: cfg.merchantId, TerminalId: cfg.terminalId,
    TxnRefNo: txnRefNo, PassCode: cfg.passCode, TxnType: "Status", MCC: cfg.mcc,
    Version: cfg.version, // "" omitted from hash and body
  };
  // Form-encoded POST body (PDF: POST only; encoding UNCONFIRMED). Not the kit's
  // query string, which put PassCode in a logged URL and truncated the hash with slice(0,-2).
  const sent = Object.fromEntries(Object.entries(fields).filter(([, v]) => present(v)));
  sent.SecureHash = secureHash(sent, cfg.secureSecret);
  const body = new URLSearchParams(sent).toString();
  const contentType = "application/x-www-form-urlencoded";
  isgpayLog("status_request", { txnRefNo, method: "POST", endpoint: pathOf(cfg.statusUrl), query: "none",
    contentType, bodyFields: Object.keys(sent), bodyBytes: Buffer.byteLength(body), version: cfg.version || "absent" });

  let lastReason = "network";
  for (let i = 0; i < STATUS_TRIES; i++) {
    let res;
    try {
      res = await axios.post(cfg.statusUrl, body, {
        headers: { "Content-Type": contentType },
        timeout: STATUS_TIMEOUT_MS, maxRedirects: 0, responseType: "text", transformResponse: (d) => d,
      });
    } catch (err) {
      lastReason = failureReason(err);
      isgpayLog("status_response", { txnRefNo, try: i + 1, error: lastReason,
        ...(err?.response ? responseShape(err.response) : {}) });
      if (err?.response && err.response.status < 500) break; // 4xx: retrying won't help
      continue;
    }
    const shape = { txnRefNo, try: i + 1, ...responseShape(res) };
    // HTTP 200 alone proves nothing: an empty body is inconclusive, not success.
    if (shape.format === "empty") {
      isgpayLog("status_response", { ...shape, parse: "skipped", signature: "not_checked" });
      return { ok: false, reason: "empty_response" };
    }
    let record;
    try { record = parseStatusBody(res.data, cfg); }
    catch {
      isgpayLog("status_response", { ...shape, parse: "failed", signature: "not_checked" });
      return { ok: false, reason: "unparseable" };
    }
    const sig = secureHashMatch(record, cfg.secureSecret);
    // responseCode logged even when unsigned so a provider error code is visible; it decides nothing.
    isgpayLog("status_response", { ...shape, parse: "ok", fields: names(record), signature: sig || "invalid",
      responseCode: short(record.ResponseCode, 12) });
    if (!sig) return { ok: false, reason: "hash" };
    return { ok: true, record };
  }
  return { ok: false, reason: lastReason };
}

// ── Classification + settlement ───────────────────────────────────────────

// Clear declines / cancellations from the v1.6 response-code table. Any other
// non-"00" code is left pending: the PDF doesn't say which codes are final.
const FAILED = new Set(["01", "03", "04", "05", "07", "12", "13", "14", "15", "17", "31", "34", "3DSF", "41",
  "412", "43", "51", "54", "55", "57", "58", "59", "62", "63", "CAN", "DAUTH", "OTPCAN", "HNM", "N7"]);

/** @returns {"paid"|"failed"|"pending"} */
export function classifyResponseCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (c === "00") return "paid";
  if (FAILED.has(c)) return "failed";
  return "pending";
}

/**
 * Apply a VERIFIED Sale Status record to one attempt. Pure, idempotent.
 * Before "paid": TxnRefNo/MerchantId/TerminalId/BankId match, amount matches the
 * attempt and the order total. A paid order is never downgraded or re-completed.
 */
export function applyStatus(order, attempt, record, cfg = isgpayConfig()) {
  if (record.TxnRefNo !== attempt.txnRefNo) return { outcome: "mismatch", reason: "txnrefno", status: order.status };
  if (record.MerchantId !== cfg.merchantId || record.TerminalId !== cfg.terminalId || record.BankId !== cfg.bankId)
    return { outcome: "mismatch", reason: "identity", status: order.status };

  const now = new Date().toISOString();
  const outcome = classifyResponseCode(record.ResponseCode);
  attempt.providerStatus = String(record.ResponseCode ?? "");
  attempt.retRefNo = record.RetRefNo || attempt.retRefNo || null;
  attempt.pgTxnId = record.pgTxnId || attempt.pgTxnId || null;
  attempt.verifiedAt = now;

  if (outcome === "paid") {
    // Amount is Optional in the status table; a hash-verified return/callback amount counts.
    const amount = present(record.Amount) ? record.Amount : attempt.signedAmount;
    if (!amount || amount !== attempt.amount || amount !== toPaise(order.total))
      return { outcome: "mismatch", reason: "amount", status: order.status };
    if (present(record.Currency) && record.Currency !== attempt.currency)
      return { outcome: "mismatch", reason: "currency", status: order.status };
    attempt.verified = true;
    if (order.status === "paid") {
      if (order.isgpayPaidTxnRefNo !== attempt.txnRefNo) {
        attempt.duplicateCharge = true; // second success on a paid order: refund review
        console.warn("[isgpay] duplicate success on already-paid order", order.id);
      }
      return { outcome: "paid", status: "paid" };
    }
    // Order completion — runs once.
    order.status = "paid";
    order.paidAt = now;
    order.paidAmount = order.total;
    order.isgpayPaidTxnRefNo = attempt.txnRefNo;
    order.updatedAt = now;
    return { outcome: "paid", status: "paid" };
  }

  if (order.status === "paid") return { outcome, status: "paid" }; // stale failure can't downgrade
  const latest = order.isgpayAttempts?.[order.isgpayAttempts.length - 1];
  if (latest !== attempt) return { outcome, status: order.status };
  if (outcome === "failed") { order.status = "failed"; order.updatedAt = now; }
  return { outcome, status: order.status };
}

/** Query + apply. outcome adds "unavailable" | "not_configured". Never throws. */
export async function reconcileAttempt(order, attempt, cfg = isgpayConfig()) {
  if (isgpayMissingConfig(cfg).length) return { outcome: "not_configured", status: order.status };
  attempt.lastCheckedAt = Date.now();
  const res = await querySaleStatus(attempt.txnRefNo, cfg);
  if (!res.ok) {
    console.warn("[isgpay status] inconclusive for", order.id, res.reason);
    return { outcome: "unavailable", reason: res.reason, status: order.status };
  }
  const applied = applyStatus(order, attempt, res.record, cfg);
  if (applied.outcome === "mismatch") console.warn("[isgpay status] mismatch:", applied.reason, "for", order.id);
  return applied;
}

const REFRESH_MIN_INTERVAL_MS = 10000;

/** Order-page poll hook: re-check a pending ISGPay order (throttled). */
export async function refreshIsgpayOrder(order, cfg = isgpayConfig()) {
  if (order?.gateway !== ISGPAY_GATEWAY || order.status !== "pending") return;
  const attempt = order.isgpayAttempts?.[order.isgpayAttempts.length - 1];
  if (!attempt || Date.now() - (attempt.lastCheckedAt || 0) < REFRESH_MIN_INTERVAL_MS) return;
  try { await reconcileAttempt(order, attempt, cfg); }
  catch (err) { console.warn("[isgpay refresh] failed for", order.id, err.message); }
}
