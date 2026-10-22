// Opt-in, payload-free diagnostics for the AirPay 2 → KKChat relay.
//
// Two parts:
//
// 1. Always on, and part of every relay request (they carry no payment data):
//      User-Agent: Firvanra-AirPay2-Relay/1.0 (+https://firvanra.online)
//      X-Firvanra-Relay-Id: fr-<uuid>     one per attempt
//    nginx's default "combined" access log records the User-Agent, so KKChat
//    can find Firvanra's requests (and the attempt id inside it) without any
//    configuration change on their side. The relay id is also in Firvanra's
//    summary log line, so both sides can match the same attempt.
//
// 2. Debug records, OFF unless ALL of these are set (read per call):
//      AIRPAY2_KKCHAT_DEBUG=true
//      AIRPAY2_KKCHAT_DEBUG_UNTIL=<ISO-8601 time, at most 7 days ahead>
//      AIRPAY2_KKCHAT_DEBUG_ORDER_ID=<id>[,<id>…]  and/or
//      AIRPAY2_KKCHAT_DEBUG_TXN_ID=<AirPay txn id>[,…]
//    and the callback's orderid or AirPay transaction id is one of the listed
//    values. An order id can be chosen before a controlled payment; a txn id
//    only exists after checkout. The window closes by itself at
//    AIRPAY2_KKCHAT_DEBUG_UNTIL.
//
// What a debug record contains: destination, method, allowlisted request
// headers, field NAMES and value TYPES, duplicate names, byte length, SHA-256
// of the exact outgoing body, timings, and allowlisted response headers
// (Set-Cookie: cookie NAMES only). It never contains a field value, the
// response body, ap_SecureHash, credentials or tokens. The SHA-256 lets KKChat
// confirm the bytes they logged are the bytes Firvanra sent; it proves
// nothing about processing.

import crypto from "node:crypto";
import { lookup } from "node:dns/promises";

export const RELAY_USER_AGENT = "Firvanra-AirPay2-Relay/1.0 (+https://firvanra.online)";
export const RELAY_ID_HEADER = "X-Firvanra-Relay-Id";

export const newRelayId = () => `fr-${crypto.randomUUID()}`;

const MAX_IDS = 5;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAMES = 60;
const DNS_TIMEOUT_MS = 1000;

const idList = (name) => (process.env[name] || "")
  .split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_IDS);

let warnedWindow = null;

/**
 * Should this callback get debug records?
 * @returns {null|"order_id"|"txn_id"} which configured id matched, or null.
 */
export function debugMatch({ orderid, apTxnId } = {}, now = Date.now()) {
  if ((process.env.AIRPAY2_KKCHAT_DEBUG || "").trim().toLowerCase() !== "true") return null;

  const untilRaw = (process.env.AIRPAY2_KKCHAT_DEBUG_UNTIL || "").trim();
  const until = Date.parse(untilRaw);
  // No window, an unreadable one, an expired one, or one longer than allowed:
  // stay off. Warn once per value so a misconfiguration is visible.
  if (!Number.isFinite(until) || until <= now || until - now > MAX_WINDOW_MS) {
    if (warnedWindow !== untilRaw) {
      warnedWindow = untilRaw;
      console.warn("[airpay2 forward] debug disabled: AIRPAY2_KKCHAT_DEBUG_UNTIL missing, invalid, expired or more than 7 days ahead");
    }
    return null;
  }

  if (orderid && idList("AIRPAY2_KKCHAT_DEBUG_ORDER_ID").includes(String(orderid))) return "order_id";
  if (apTxnId && idList("AIRPAY2_KKCHAT_DEBUG_TXN_ID").includes(String(apTxnId))) return "txn_id";
  return null;
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const bound = (names) => names.slice(0, MAX_NAMES).map((n) => String(n).slice(0, 40));

/**
 * Payload-free description of the exact outgoing request.
 * @param {{format:string, headers:object, body:Buffer|string}} request
 * @param {{rawBody?:Buffer|string, sourceFormat?:string}} source
 */
export function describeRequest(request, { rawBody, sourceFormat } = {}) {
  const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""), "utf8");
  const out = {
    request_bytes: bytes.length,
    request_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };

  // What the receiver will see: JSON keys and value types, or form names.
  const text = bytes.toString("utf8");
  if (request.format === "json") {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const names = Object.keys(obj);
        out.field_names = bound(names);
        out.field_types = Object.fromEntries(names.slice(0, MAX_NAMES).map((n) => [String(n).slice(0, 40), typeOf(obj[n])]));
      } else out.body_shape = typeOf(obj);
    } catch { out.body_shape = "unparseable_json"; }
  } else {
    out.field_names = bound([...new Set(new URLSearchParams(text).keys())]);
  }
  if (out.field_names && out.field_names.length >= MAX_NAMES) out.field_names_truncated = true;

  // A form body can repeat a name; the JSON object keeps only the last value.
  if (sourceFormat === "form" && rawBody !== undefined) {
    const seen = new Set(), dup = new Set();
    for (const k of new URLSearchParams(Buffer.from(rawBody).toString("utf8")).keys())
      (seen.has(k) ? dup : seen).add(k);
    if (dup.size) out.duplicate_field_names = bound([...dup]);
  }
  return out;
}

const REQUEST_HEADER_ALLOW = ["content-type", "accept", "user-agent", RELAY_ID_HEADER.toLowerCase()];
/** Only the allowlisted request headers, plus the computed Content-Length. */
export function safeRequestHeaders(headers, byteLength) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {}))
    if (REQUEST_HEADER_ALLOW.includes(k.toLowerCase())) out[k] = String(v).slice(0, 120);
  out["Content-Length"] = String(byteLength);
  return out;
}

const RESPONSE_HEADER_ALLOW = [
  "content-type", "content-length", "server", "date", "via", "x-powered-by",
  "x-request-id", "x-cache", "location", "transfer-encoding", "connection",
];
/**
 * Allowlisted response headers. Set-Cookie becomes cookie NAMES only (e.g.
 * JSESSIONID shows a servlet container answered, not nginx alone).
 */
export function safeResponseHeaders(headers) {
  const out = {};
  for (const name of RESPONSE_HEADER_ALLOW) {
    const v = headers.get(name);
    if (v) out[name] = (name === "location" ? v.split("?")[0] : v).slice(0, 80);
  }
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (cookies.length) out.set_cookie_names = bound(cookies.map((c) => c.split("=")[0].trim()));
  return out;
}

/** Addresses the destination host resolves to from this instance. Never throws. */
export async function resolveHost(host) {
  try {
    const addrs = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("dns_timeout")), DNS_TIMEOUT_MS).unref?.()),
    ]);
    return addrs.slice(0, 8).map((a) => `${a.address}/v${a.family}`);
  } catch (err) {
    return [err?.message === "dns_timeout" ? "dns_timeout" : "dns_error"];
  }
}

export function logDebug(event, record) {
  console.log(`[airpay2 forward debug] ${event} ` + JSON.stringify(record));
}
