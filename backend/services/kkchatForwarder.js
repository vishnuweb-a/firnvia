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
// Response. Four separate facts, never folded into one Boolean:
//   transport_delivered  the POST completed with a 2xx from KKChat.
//   response valid       Content-Type is application/json AND the body parses.
//   acknowledgement      KKChat confirmed processing (needs AIRPAY2_KKCHAT_ACK).
//   payment recorded     never known here; only KKChat can confirm it.
//
// A 2xx is a TRANSPORT delivery whatever its body (as Frontiva treats it): the
// receiver may already have processed the callback, so answering AirPay with a
// re-send signal would only risk a duplicate notification. A body that breaks
// the JSON contract (HTML, text, empty, malformed, oversized, non-JSON
// Content-Type) is reported as `response_issue`, with bounded, payload-free
// diagnostics, and logged as a warning. AIRPAY2_KKCHAT_STRICT_RESPONSE=true
// restores the previous behaviour: such a 2xx fails as `response_<issue>`.
//
// Acknowledgement (AIRPAY2_KKCHAT_ACK, read per call), "field=value[|value…]":
//   unset  a 2xx is a delivery, reported "unconfirmed": receipt is established,
//          business processing is not. Not retried.
//   set    a 2xx is a delivery only if the JSON response has `field` equal to
//          one of the values ("confirmed"). The field with another value is
//          "rejected" (not retried); a missing field is "unconfirmed" (not
//          retried). Both fail the delivery.
// No schema is assumed here: the field and values come from KKChat's contract.
//
// Identification and diagnostics (services/kkchatDiagnostics.js): every
// attempt carries User-Agent: Firvanra-AirPay2-Relay/1.0 and a fresh
// X-Firvanra-Relay-Id, which the summary log reports as relay_ids, so KKChat
// can match its nginx access log to a Firvanra attempt. Payload-free debug
// records before and after each attempt are opt-in per order / txn id.
//
// Delivery is best-effort. There is no durable queue (the app has no database):
// retries are bounded and happen inside the current request only, and the
// dedup memory below is per-process and lost on restart / across Vercel
// instances. A delivery that fails here is lost unless AirPay re-sends the
// callback — which the route encourages by not acknowledging an IPN whose
// forwarding failed.

import {
  RELAY_ID_HEADER, RELAY_USER_AGENT, debugMatch, describeRequest, logDebug,
  newRelayId, resolveHost, safeRequestHeaders, safeResponseHeaders,
} from "./kkchatDiagnostics.js";

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

/** AIRPAY2_KKCHAT_STRICT_RESPONSE=true: a 2xx that breaks the JSON contract fails. */
export const strictResponse = () =>
  (process.env.AIRPAY2_KKCHAT_STRICT_RESPONSE || "").trim().toLowerCase() === "true";

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

/**
 * Node decoding for the Content-Type charset. Single-byte Western charsets
 * decode as latin1; everything else as UTF-8 (JSON's default). JSON's
 * structure is ASCII, so the charset can only change characters inside
 * strings, never whether the body parses. Exported for tests.
 * @returns {{charset:string, encoding:"utf8"|"latin1"}}
 */
export function responseCharset(contentType) {
  const m = /;\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(String(contentType || ""));
  const charset = m ? m[1].toLowerCase().slice(0, 20) : "";
  const latin1 = /^(iso-?8859-1|latin-?1|l1|us-ascii|ascii|windows-1252|cp1252)$/.test(charset);
  return { charset: charset || "none", encoding: latin1 ? "latin1" : "utf8" };
}

// Read at most `limit` bytes of the response, then stop the download.
async function readBounded(res, limit, encoding) {
  if (!res.body) return { text: "", truncated: false, bytes: 0 };
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
  let buf = Buffer.concat(chunks).subarray(0, limit);
  // A UTF-8 BOM is not JSON; strip its bytes whatever charset was declared.
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  return { text: buf.toString(encoding), truncated, bytes: Math.min(size, limit) };
}

/**
 * Payload-free description of a response body, for logs. The body itself is
 * never logged: it may echo payment data. Exported for tests.
 * @returns {{shape:string, word?:string}}
 *   shape: first non-blank character class — "object" | "array" | "markup" |
 *          "quoted" | "word" | "digit" | "other" | "empty"
 *   word:  the whole body, only when it is one short bare word of letters (a
 *          status word such as SUCCESS or OK); never digits or spaces, so never
 *          an id, an amount or a name.
 */
export function describeBody(text) {
  const t = String(text || "").trim();
  if (!t) return { shape: "empty" };
  const c = t[0];
  const shape = c === "{" ? "object" : c === "[" ? "array" : c === "<" ? "markup"
    : c === '"' || c === "'" ? "quoted" : /[A-Za-z]/.test(c) ? "word" : /\d/.test(c) ? "digit" : "other";
  return /^[A-Za-z][A-Za-z_-]{0,23}$/.test(t) ? { shape, word: t } : { shape };
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

// `debug`: null, or the payload-free fields shared by this callback's debug records.
async function attemptOnce(request, timeoutMs, rule, strict, debug, attempt) {
  const relay_id = newRelayId();
  const headers = { ...request.headers, "User-Agent": RELAY_USER_AGENT, [RELAY_ID_HEADER]: relay_id };
  const started = Date.now();
  if (debug)
    logDebug("request", {
      ...debug, relay_id, attempt, started_at: new Date(started).toISOString(),
      request_headers: safeRequestHeaders(headers, debug.request_bytes),
    });
  const result = await sendOnce(request, headers, timeoutMs, rule, strict);
  result.relay_id = relay_id;
  if (debug) {
    const ended = Date.now();
    const r = result.response;
    logDebug("response", {
      relay_id, attempt, orderid: debug.orderid, ap_transactionid: debug.ap_transactionid,
      started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString(),
      elapsed_ms: ended - started,
      // A thrown fetch may have failed before or after the bytes left: unknown.
      request_sent: result.status !== undefined ? true : "unknown",
      http_response_received: result.status !== undefined,
      ...(result.status !== undefined && { http_status: result.status }),
      ...(result.response_headers && { response_headers: result.response_headers }),
      ...(r && {
        response_bytes: r.bytes, response_truncated: r.truncated, response_kind: r.kind,
        response_json: r.json, response_charset: r.charset, response_shape: r.shape,
        ...(r.word && { response_word: r.word }), ...(r.issue && { response_issue: r.issue }),
      }),
      transport_delivered: result.transport_delivered,
      response_valid: Boolean(r && r.json === "parsed" && r.content_type_json),
      application_acknowledged: r?.acknowledgement === "confirmed",
      payment_recorded: "unconfirmed",
      ...(result.error && { error: result.error }),
    });
  }
  delete result.response_headers;
  return result;
}

async function sendOnce(request, headers, timeoutMs, rule, strict) {
  try {
    const res = await fetch(KKCHAT_AIRPAY2_CALLBACK_URL, {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual", // a redirect is not a delivery
      signal: AbortSignal.timeout(timeoutMs),
    });
    const response_headers = safeResponseHeaders(res.headers);
    const contentType = res.headers.get("content-type") || "";
    const { charset, encoding } = responseCharset(contentType);
    // The body is inspected but never logged: it may echo payment data.
    const read = await readBounded(res, MAX_RESPONSE_BYTES, encoding)
      .catch(() => ({ text: "", truncated: false, bytes: 0, read_error: true }));
    const response = {
      content_type: contentType.slice(0, 100),
      charset,
      bytes: read.bytes,
      truncated: read.truncated,
      ...(read.read_error && { read_error: true }),
      // Which software answered (e.g. a proxy's error page vs the app server).
      ...(res.headers.get("server") && { server: res.headers.get("server").slice(0, 40) }),
      ...describeBody(read.text),
      ...inspectResponse({ contentType, ...read }, rule),
    };

    if (res.status < 200 || res.status >= 300)
      return {
        ok: false, transport_delivered: false, status: res.status, response, response_headers,
        ...(res.status >= 300 && res.status < 400 && { error: "redirect_not_followed" }),
        retryable: res.status >= 500 || res.status === 429,
      };

    // From here KKChat answered 2xx: the request was delivered.
    const issue = request.format === "json" ? jsonContractViolation(response) : null;
    if (issue) response.issue = issue;
    // Strict (rollback) mode only: a 2xx outside the JSON contract fails.
    if (issue && strict)
      return { ok: false, transport_delivered: true, status: res.status, response, response_headers,
        error: `response_${issue}`, retryable: false };
    // No ack rule: a 2xx is a delivery, reported as unconfirmed.
    if (!rule || response.acknowledgement === "confirmed")
      return { ok: true, transport_delivered: true, status: res.status, response, response_headers };
    // Contract configured but not met. Deterministic, so not retried here.
    return { ok: false, transport_delivered: true, status: res.status, response, response_headers,
      error: `ack_${response.acknowledgement}`, retryable: false };
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, transport_delivered: false, error: timeout ? "timeout" : "network", retryable: true };
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
 * @param {object}        [p.diag]       non-sensitive ids for opt-in debug records:
 *                                       { orderid, apTxnId, queryNames }
 * @returns {Promise<{ok:boolean, duplicate?:boolean, transport_delivered:boolean,
 *   status?:number, error?:string,
 *   attempts?:number, request_format?:string, request_content_type?:string,
 *   response?:object, acknowledgement?:string, relay_ids?:string[]}>}
 */
export async function forwardAirpay2Callback({
  rawBody, contentType, fields, sourceFormat, dedupKey, logRef = "", diag = {},
  timeoutMs = DEFAULT_TIMEOUT_MS, attempts = DEFAULT_ATTEMPTS,
}) {
  const match = debugMatch(diag);
  const ids = { orderid: diag.orderid, ap_transactionid: diag.apTxnId };
  if (dedupKey && delivered.has(dedupKey)) {
    console.log("[airpay2 forward] duplicate, already delivered:", logRef);
    if (match) logDebug("not_sent", { ...ids, debug_match: match, reason: "duplicate_already_delivered" });
    return { ok: true, duplicate: true, transport_delivered: true,
      acknowledgement: delivered.get(dedupKey).acknowledgement };
  }
  // A browser return and an IPN for the same event can race: share one delivery.
  if (dedupKey && inFlight.has(dedupKey)) {
    if (match) logDebug("not_sent", { ...ids, debug_match: match, reason: "duplicate_in_flight" });
    const shared = await inFlight.get(dedupKey);
    return { ...shared, duplicate: true };
  }

  const request = buildKkchatRequest({ format: forwardFormat(), rawBody, contentType, fields, sourceFormat });
  const rule = ackRule();
  const strict = strictResponse();

  const run = (async () => {
    const debug = match && {
      ...ids, debug_match: match,
      destination: KKCHAT_AIRPAY2_CALLBACK_URL, method: "POST",
      incoming_format: sourceFormat || (/json/i.test(contentType) ? "json" : "form"),
      request_format: request.format,
      ...(diag.queryNames?.length && {
        query_field_names: diag.queryNames.slice(0, 20).map((n) => String(n).slice(0, 40)),
      }),
      ...describeRequest(request, { rawBody, sourceFormat }),
      destination_addresses: await resolveHost(new URL(KKCHAT_AIRPAY2_CALLBACK_URL).hostname),
    };
    let last;
    const relay_ids = [];
    for (let i = 1; i <= attempts; i++) {
      last = await attemptOnce(request, timeoutMs, rule, strict, debug, i);
      relay_ids.push(last.relay_id);
      if (last.ok || !last.retryable || i === attempts) {
        last.attempts = i;
        break;
      }
      await sleep(RETRY_DELAY_MS * i);
    }
    const acknowledgement = last.response?.acknowledgement || "unconfirmed";
    const log = {
      ref: logRef, relay_ids, request_format: request.format, status: last.status,
      transport_delivered: last.transport_delivered,
      error: last.error, attempts: last.attempts, response: last.response,
    };
    if (last.ok) {
      if (dedupKey) remember(dedupKey, acknowledgement);
      // An HTML 2xx is most likely a fallback page, not KKChat's handler.
      if (last.response?.kind === "html") console.warn("[airpay2 forward] 2xx with an HTML body:", log);
      else if (last.response?.issue)
        console.warn("[airpay2 forward] delivered (2xx), response outside the JSON contract:", log);
      else console.log("[airpay2 forward] delivered:", log);
    } else {
      console.error("[airpay2 forward] failed:", log);
    }
    const { retryable, relay_id, ...result } = last;
    return {
      ...result, acknowledgement, relay_ids,
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
