// PayU Hosted Checkout integration (production only).
// Flow: build a self-POSTing form → customer lands on secure.payu.in → PayU POSTs
// back to our callback → we verify the reverse hash before trusting anything.
//
// It also performs the authoritative server-to-server Verify Payment call; that
// result — not the browser return and not the webhook — decides "paid".
//
// Request hash:  sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5|||||| SALT)
// Response hash: sha512(SALT|status|||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key)

import crypto from "crypto";
import { nanoid } from "nanoid";

const PRODUCTION_PAYMENT_URL = "https://secure.payu.in/_payment";

// No test fallbacks anywhere: an unset variable must read as unconfigured, never
// as "assume sandbox".
const cfg = {
  env:           process.env.PAYU_ENV,
  key:           process.env.PAYU_KEY,
  salt:          process.env.PAYU_SALT,
  paymentUrl:    process.env.PAYU_PAYMENT_URL,
  verifyUrl:     process.env.PAYU_VERIFY_URL,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
};

/** Non-secret view of the configuration. The Salt is deliberately not included. */
export const payuPublicConfig = () => ({
  env:           cfg.env,
  key:           cfg.key,
  paymentUrl:    cfg.paymentUrl,
  publicBaseUrl: cfg.publicBaseUrl,
});

/** True only when the full PayU configuration exists and points at production. */
export function payuConfigured() {
  return Boolean(
    cfg.key &&
    cfg.salt &&
    cfg.env === "production" &&
    cfg.paymentUrl === PRODUCTION_PAYMENT_URL &&
    cfg.verifyUrl &&
    cfg.publicBaseUrl &&
    cfg.publicBaseUrl.startsWith("https://")
  );
}

function requireConfigured() {
  if (!payuConfigured()) throw new Error("PayU production configuration incomplete");
}

// Never log the input: every hash sequence here contains the Salt.
function sha512(value) {
  return crypto.createHash("sha512").update(String(value), "utf8").digest("hex");
}

/**
 * Normalize a trusted rupee amount to PayU's two-decimal string form.
 * Rejects anything that is not a finite number strictly greater than zero.
 */
export function formatPayUAmount(amount) {
  if (typeof amount === "boolean" || amount === null || amount === "") {
    throw new Error("PayU order amount invalid");
  }
  const n = typeof amount === "number" ? amount : Number(String(amount).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error("PayU order amount invalid");
  return n.toFixed(2);
}

/**
 * Server-side transaction id, unique per attempt.
 * PayU allows at most 25 characters from [A-Za-z0-9-_], so the order reference is
 * truncated and the remainder filled with random entropy (never time alone).
 */
export function createPayUTxnId(orderId) {
  if (orderId === undefined || orderId === null || String(orderId).trim() === "") {
    throw new Error("PayU order id missing");
  }
  const ref = String(orderId).replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  const prefix = ref ? `PU_${ref}_` : "PU_";
  return (prefix + nanoid(25 - prefix.length).replace(/[^A-Za-z0-9-_]/g, "X")).slice(0, 25);
}

/** Deterministic, PII-free description of the order. */
export function buildProductInfo(orderId) {
  return `Firvanra Order ${orderId}`;
}

/** `<PUBLIC_BASE_URL>/api/payment/payu/callback`, with a trailing slash normalized. */
export function payuCallbackUrl() {
  requireConfigured();
  return `${cfg.publicBaseUrl.replace(/\/+$/, "")}/api/payment/payu/callback`;
}

/**
 * Hosted Checkout request hash. The Salt is read from configuration here; callers
 * must never supply it.
 *
 * key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
 */
export function generatePaymentHash(params) {
  requireConfigured();
  const { txnid, amount, productinfo, firstname, email } = params;
  const udf = [1, 2, 3, 4, 5].map((i) => params[`udf${i}`] ?? "");

  const sequence = [
    cfg.key, txnid, amount, productinfo, firstname, email,
    ...udf,
    "", "", "", "", "",   // five reserved empty slots
    cfg.salt,
  ].join("|");

  return sha512(sequence);
}

/** sha512(key|command|var1|salt) — the Verify Payment API command hash. */
export function generateCommandHash(command, var1) {
  requireConfigured();
  return sha512(`${cfg.key}|${command}|${var1}|${cfg.salt}`);
}

function requireField(value, message) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(message);
  }
  return String(value).trim();
}

/**
 * Build the Hosted Checkout form descriptor for a trusted internal order.
 * The amount is taken from `order.total` only — never from the browser.
 */
export function buildPayUCheckout(order) {
  requireConfigured();
  if (!order || typeof order !== "object") throw new Error("PayU order id missing");

  const orderId = requireField(order.id, "PayU order id missing");
  const buyer = order.buyer;
  if (!buyer || typeof buyer !== "object") throw new Error("PayU buyer first name missing");

  const firstname = requireField(buyer.firstName, "PayU buyer first name missing");
  const email     = requireField(buyer.email,     "PayU buyer email missing");
  const phone     = requireField(buyer.phone,     "PayU buyer phone missing");
  const lastname  = buyer.lastName ? String(buyer.lastName).trim() : "";

  const amount      = formatPayUAmount(order.total);
  const txnid       = createPayUTxnId(orderId);
  const productinfo = buildProductInfo(orderId);
  const callback    = payuCallbackUrl();

  // udf1 is our only mapping back to the internal order. No PII, no secrets.
  const udfs = { udf1: orderId, udf2: "", udf3: "", udf4: "", udf5: "" };

  const hash = generatePaymentHash({ txnid, amount, productinfo, firstname, email, ...udfs });

  return {
    type: "form",
    provider: "payu",
    environment: "production",
    action: cfg.paymentUrl,
    method: "POST",
    fields: {
      key: cfg.key,
      txnid,
      amount,
      productinfo,
      firstname,
      lastname,
      email,
      phone,
      surl: callback,
      furl: callback,
      ...udfs,
      hash,
    },
  };
}

/**
 * Verify the reverse hash on a PayU response. Pure: it updates nothing.
 * Fails closed on a missing, malformed or mismatched hash, and on missing fields.
 *
 * Base:                SALT|status|||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
 * With additionalCharges: additionalCharges|<base>
 */
export function verifyPayUResponseHash(payload) {
  if (!payuConfigured()) throw new Error("PayU production configuration incomplete");
  if (!payload || typeof payload !== "object") return false;

  const received = typeof payload.hash === "string" ? payload.hash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{128}$/.test(received)) return false;

  for (const field of ["status", "email", "firstname", "productinfo", "amount", "txnid"]) {
    const v = payload[field];
    if (v === undefined || v === null || String(v) === "") return false;
  }
  if (String(payload.key) !== String(cfg.key)) return false;

  const udf = [5, 4, 3, 2, 1].map((i) => payload[`udf${i}`] ?? "");
  let sequence = [
    cfg.salt, payload.status,
    "", "", "", "", "", "",   // six reserved empty slots
    ...udf,
    payload.email, payload.firstname, payload.productinfo, payload.amount,
    payload.txnid, cfg.key,
  ].join("|");

  // PayU prepends additionalCharges when the field is present on the response.
  const extra = payload.additionalCharges;
  if (extra !== undefined && extra !== null && String(extra) !== "") {
    sequence = `${extra}|${sequence}`;
  }

  const expected = sha512(sequence);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Verify Payment API (server-to-server) ────────────────────────────────────
// The only authoritative source of payment truth. A webhook or browser return
// merely tells us to come and ask PayU; this function asks.
//
// POST PAYU_VERIFY_URL  (application/x-www-form-urlencoded)
//   key | command=verify_payment | var1=<our txnid> | hash=sha512(key|command|var1|salt)
//
// The Salt is never a form field — it only ever enters the command hash.

const VERIFY_TIMEOUT_MS = 9000;

/** Trim to a string, or null when the value is absent/blank. */
function optional(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Ask PayU for the authoritative state of one of OUR transactions.
 *
 * @param {string} txnid - a txnid previously generated and stored by this server.
 *                         Never a value taken from a request body.
 * @returns {Promise<object>} normalized, secret-free result:
 *   { ok: true, found: true, txnid, mihpayid, paymentStatus, unmappedStatus,
 *     amount, productinfo, udf1, mode, bankRefNum }
 *   { ok: true, found: false }                 transaction unknown to PayU
 *   { ok: false, reason: "<short code>" }      request/transport/parse failure
 *
 * Never throws for network conditions, and never returns the raw PayU response,
 * the merchant key, the Salt or the command hash.
 */
export async function verifyPayUPayment(txnid) {
  if (!payuConfigured()) return { ok: false, reason: "payu_not_configured" };

  const id = txnid === undefined || txnid === null ? "" : String(txnid).trim();
  if (!id) return { ok: false, reason: "txnid_missing" };

  const command = "verify_payment";
  const body = new URLSearchParams({
    key: cfg.key,
    command,
    var1: id,
    hash: generateCommandHash(command, id),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(cfg.verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    // Includes the AbortController timeout. Deliberately no URL, no body.
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { ok: false, reason: "http_error" };

  let parsed;
  try {
    const text = await response.text();
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "invalid_response" };

  const details = parsed.transaction_details;
  // PayU returns status=1 for "the API call worked" — that says nothing about
  // the payment itself, so the transaction record is the only thing we read.
  if (!details || typeof details !== "object") return { ok: false, reason: "no_transaction_details" };

  const txn = details[id];
  if (!txn || typeof txn !== "object") return { ok: true, found: false };

  return {
    ok: true,
    found: true,
    txnid:          optional(txn.txnid),
    mihpayid:       optional(txn.mihpayid),
    paymentStatus:  optional(txn.status)?.toLowerCase() ?? null,
    unmappedStatus: optional(txn.unmappedstatus)?.toLowerCase() ?? null,
    // Original merchant transaction amount only. net_amount_debit /
    // transaction_amount / additional_charges have different semantics and must
    // never authorize a payment.
    amount:         optional(txn.amt),
    productinfo:    optional(txn.productinfo),
    udf1:           optional(txn.udf1),
    mode:           optional(txn.mode),
    bankRefNum:     optional(txn.bank_ref_num),
  };
}
