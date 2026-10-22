// Backend-to-backend relay of AirPay 2 callbacks to KKChat.
//
// The destination is a constant. Nothing from the request can change it.
//
// KKChat's confirmed contract: the request is JSON in AirPay's own callback
// structure (AirPay's field names, uppercase included), and the response is
// application/json. Its success-response BODY has not been supplied.
//
// Request format (AIRPAY2_KKCHAT_FORMAT, read per call):
//   "json" (default; also any unrecognised value) Content-Type/Accept:
//          application/json. A JSON callback is sent as its original bytes
//          (names, types and formatting untouched); a form callback is sent as a
//          JSON object of its original field names and string values. Nothing is
//          added, renamed or dropped. ap_SecureHash is a CRC32 over field VALUES
//          (see services/airpay2.js), so it stays verifiable.
//   "form" | "raw"  rollback: the callback's ORIGINAL raw bytes with its
//          ORIGINAL content type, and the previous lenient response handling
//          (any 2xx is a delivery).
//
// Response, json format: a 2xx counts as RECEIVED only when its Content-Type is
// application/json and its body parses as JSON. HTML, text, empty, malformed or
// oversized bodies and a non-JSON Content-Type fail the delivery
// (`response_<reason>`) without an in-request retry: something answered, but not
// KKChat's JSON handler as contracted.
//
// Acknowledgement (AIRPAY2_KKCHAT_ACK, read per call), "field=value[|value…]":
//   unset  a received response is a delivery, reported "unconfirmed": receipt
//          is established, business processing is not. Not retried.
//   set    a 2xx is a delivery only if the JSON response has `field` equal to
//          one of the values ("confirmed"). The field with another value is
//          "rejected" (not retried); a missing field is "unconfirmed" (not
//          retried). Both fail the delivery.
// No schema is assumed here: the field and values come from KKChat's contract.
//
// Delivery is best-effort. There is no durable queue (the app has no database):
// retries are bounded and happen inside the current request only, and the
// dedup memory below is per-process and lost on restart / across Vercel
// instances. A delivery that fails here is lost unless AirPay re-sends the
// callback — which the route encourages by not acknowledging an IPN whose
// forwarding failed.

export const KKCHAT_AIRPAY2_CALLBACK_URL =
  "https://kkchat.in/callback/cpm/arp_firvanra/collection";

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_ATTEMPTS   = 2;
const RETRY_DELAY_MS     = 300;
const DEDUP_LIMIT        = 5000;
const MAX_RESPONSE_BYTES = 8192;

// key -> { at, acknowledgement } for deliveries KKChat accepted; key -> Promise while in flight.
const delivered = new Map();
const inFlight  = new Map();

function remember(key, acknowledgement) {
  delivered.set(key, { at: Date.now(), acknowledgement });
  // Bounded: evict oldest (Map preserves insertion order).
  while (delivered.size > DEDUP_LIMIT) delivered.delete(delivered.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROLLBACK_FORMATS = new Set(["form", "raw"]);
let warnedFormat = null;

/** "json" | "raw". JSON unless the rollback ("form" or "raw") is set explicitly. */
export function forwardFormat() {
  const v = (process.env.AIRPAY2_KKCHAT_FORMAT || "").trim().toLowerCase();
  if (ROLLBACK_FORMATS.has(v)) return "raw";
  if (v && v !== "json" && warnedFormat !== v) {
    warnedFormat = v;
    console.warn("[airpay2 forward] unrecognised AIRPAY2_KKCHAT_FORMAT, using json:", v.slice(0, 20));
  }
  return "json";
}

/** Parsed AIRPAY2_KKCHAT_ACK, or null when unset / malformed. */
export function ackRule() {
  const spec = (process.env.AIRPAY2_KKCHAT_ACK || "").trim();
  const eq = spec.indexOf("=");
  if (eq <= 0) return null;
  const field = spec.slice(0, eq).trim();
  const values = spec.slice(eq + 1).split("|").map((v) => v.trim()).filter(Boolean);
  return field && values.length ? { field, values } : null;
}

/**
 * The HTTP request KKChat receives for one callback.
 *
 * @param {object} p
 * @param {"raw"|"json"}  p.format
 * @param {Buffer|string} p.rawBody      exact bytes received from AirPay
 * @param {string}        p.contentType  the callback's Content-Type header
 * @param {object}        [p.fields]     the parsed callback (what was verified)
 * @param {"json"|"form"} [p.sourceFormat] how the callback was parsed; defaults
 *                                       to what contentType says
 * @returns {{format:string, headers:object, body:Buffer|string}}
 */
export function buildKkchatRequest({ format, rawBody, contentType, fields, sourceFormat }) {
  if (format !== "json") return { format: "raw", headers: { "Content-Type": contentType }, body: rawBody };
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  // Already JSON: the original bytes are the most faithful JSON there is.
  const isJson = sourceFormat ? sourceFormat === "json" : /json/i.test(contentType);
  if (isJson) return { format: "json", headers, body: rawBody };
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = v === undefined || v === null ? "" : String(v);
  return { format: "json", headers, body: JSON.stringify(obj) };
}

// Read at most `limit` bytes of the response, then stop the download.
async function readBounded(res, limit) {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > limit) { truncated = true; break; }
    }
  } finally {
    if (truncated) reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).subarray(0, limit).toString("utf8"), truncated };
}

/**
 * Classify a KKChat response. Exported for tests.
 * @returns {{kind:string, json:string, content_type_json:boolean,
 *   acknowledgement:string, ack_value?:string}}
 *   kind: "json" | "html" | "text" | "empty"
 *   json: "parsed" | "malformed" | "n/a"
 *   content_type_json: Content-Type is application/json (or a +json type)
 *   acknowledgement: "confirmed" | "rejected" | "unconfirmed"
 */
export function inspectResponse({ contentType, text, truncated }, rule) {
  const trimmed = text.trim();
  const ct = String(contentType || "");
  const content_type_json = /^\s*application\/([\w.-]+\+)?json\s*(;|$)/i.test(ct);
  let kind;
  if (!trimmed) kind = "empty";
  else if (/json/i.test(ct) || /^[{[]/.test(trimmed)) kind = "json";
  else if (/html/i.test(ct) || /^<(!doctype|html)/i.test(trimmed)) kind = "html";
  else kind = "text";

  let parsed, json = "n/a";
  if (kind === "json") {
    try { parsed = truncated ? undefined : JSON.parse(trimmed); } catch { /* malformed */ }
    json = parsed !== undefined ? "parsed" : "malformed";
  }

  if (!rule) return { kind, json, content_type_json, acknowledgement: "unconfirmed" };
  const has = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, rule.field);
  if (!has) return { kind, json, content_type_json, acknowledgement: "unconfirmed" };
  const value = String(parsed[rule.field]);
  // The value is a status word from KKChat, never payment data: bounded and logged.
  return {
    kind, json, content_type_json,
    acknowledgement: rule.values.includes(value) ? "confirmed" : "rejected",
    ack_value: value.slice(0, 40),
  };
}

/**
 * Why a 2xx response breaks the JSON response contract, or null when it is
 * parsed JSON served as application/json. Exported for tests.
 * @returns {null|"html"|"empty"|"not_json"|"malformed_json"|"content_type"}
 */
export function jsonContractViolation(response) {
  if (response.kind === "html") return "html";
  if (response.kind === "empty") return "empty";
  if (response.kind === "text") return "not_json";
  if (response.json !== "parsed") return "malformed_json";
  if (!response.content_type_json) return "content_type";
  return null;
}

async function attemptOnce(request, timeoutMs, rule) {
  try {
    const res = await fetch(KKCHAT_AIRPAY2_CALLBACK_URL, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual", // a redirect is not a delivery
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") || "";
    // The body is inspected but never logged: it may echo payment data.
    const read = await readBounded(res, MAX_RESPONSE_BYTES).catch(() => ({ text: "", truncated: false }));
    const response = { content_type: contentType.slice(0, 100), ...inspectResponse({ contentType, ...read }, rule) };

    if (res.status < 200 || res.status >= 300)
      return { ok: false, status: res.status, response, retryable: res.status >= 500 || res.status === 429 };
    // JSON was contracted. Anything else came from something other than KKChat's
    // handler (or a broken one). Deterministic, so not retried here.
    const violation = request.format === "json" ? jsonContractViolation(response) : null;
    if (violation)
      return { ok: false, status: res.status, response, error: `response_${violation}`, retryable: false };
    // No ack rule: a received 2xx is a delivery, reported as unconfirmed.
    if (!rule || response.acknowledgement === "confirmed")
      return { ok: true, status: res.status, response };
    // Contract configured but not met. Deterministic, so not retried here.
    return { ok: false, status: res.status, response, error: `ack_${response.acknowledgement}`, retryable: false };
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, error: timeout ? "timeout" : "network", retryable: true };
  }
}

/**
 * Forward one verified callback to KKChat.
 *
 * @param {object} p
 * @param {Buffer|string} p.rawBody      exact bytes received from AirPay
 * @param {string}        p.contentType  the callback's Content-Type header
 * @param {object}        [p.fields]     the parsed, verified callback (for "json")
 * @param {"json"|"form"} [p.sourceFormat] how the callback was parsed
 * @param {string}        p.dedupKey     identity of this event (txn + status)
 * @param {string}        [p.logRef]     non-sensitive id for logs (AirPay txn id)
 * @returns {Promise<{ok:boolean, duplicate?:boolean, status?:number, error?:string,
 *   attempts?:number, request_format?:string, request_content_type?:string,
 *   response?:object, acknowledgement?:string}>}
 */
export async function forwardAirpay2Callback({
  rawBody, contentType, fields, sourceFormat, dedupKey, logRef = "",
  timeoutMs = DEFAULT_TIMEOUT_MS, attempts = DEFAULT_ATTEMPTS,
}) {
  if (dedupKey && delivered.has(dedupKey)) {
    console.log("[airpay2 forward] duplicate, already delivered:", logRef);
    return { ok: true, duplicate: true, acknowledgement: delivered.get(dedupKey).acknowledgement };
  }
  // A browser return and an IPN for the same event can race: share one delivery.
  if (dedupKey && inFlight.has(dedupKey)) {
    const shared = await inFlight.get(dedupKey);
    return { ...shared, duplicate: true };
  }

  const request = buildKkchatRequest({ format: forwardFormat(), rawBody, contentType, fields, sourceFormat });
  const rule = ackRule();

  const run = (async () => {
    let last;
    for (let i = 1; i <= attempts; i++) {
      last = await attemptOnce(request, timeoutMs, rule);
      if (last.ok || !last.retryable || i === attempts) {
        last.attempts = i;
        break;
      }
      await sleep(RETRY_DELAY_MS * i);
    }
    const acknowledgement = last.response?.acknowledgement || "unconfirmed";
    const log = {
      ref: logRef, request_format: request.format, status: last.status,
      error: last.error, attempts: last.attempts, response: last.response,
    };
    if (last.ok) {
      if (dedupKey) remember(dedupKey, acknowledgement);
      // An HTML 2xx is most likely a fallback page, not KKChat's handler.
      if (last.response?.kind === "html") console.warn("[airpay2 forward] 2xx with an HTML body:", log);
      else console.log("[airpay2 forward] delivered:", log);
    } else {
      console.error("[airpay2 forward] failed:", log);
    }
    const { retryable, ...result } = last;
    return {
      ...result, acknowledgement,
      request_format: request.format, request_content_type: request.headers["Content-Type"],
    };
  })();

  if (dedupKey) inFlight.set(dedupKey, run);
  try {
    return await run;
  } finally {
    if (dedupKey) inFlight.delete(dedupKey);
  }
}

/** Test hook: forget every remembered delivery. */
export function _resetForwarderState() {
  delivered.clear();
  inFlight.clear();
}
