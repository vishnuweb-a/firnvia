// Unit tests for the AirPay 2 → KKChat relay diagnostics.
// Run: node --test services/kkchatDiagnostics.test.js

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  RELAY_ID_HEADER, RELAY_USER_AGENT, debugMatch, describeRequest, newRelayId,
  resolveHost, safeRequestHeaders, safeResponseHeaders,
} from "./kkchatDiagnostics.js";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  for (const k of ["AIRPAY2_KKCHAT_DEBUG", "AIRPAY2_KKCHAT_DEBUG_UNTIL",
    "AIRPAY2_KKCHAT_DEBUG_ORDER_ID", "AIRPAY2_KKCHAT_DEBUG_TXN_ID"]) delete process.env[k];
});

const on = (until = new Date(NOW + HOUR).toISOString()) => {
  process.env.AIRPAY2_KKCHAT_DEBUG = "true";
  process.env.AIRPAY2_KKCHAT_DEBUG_UNTIL = until;
};

test("identification constants", () => {
  assert.equal(RELAY_USER_AGENT, "Firvanra-AirPay2-Relay/1.0 (+https://firvanra.online)");
  assert.equal(RELAY_ID_HEADER, "X-Firvanra-Relay-Id");
  const a = newRelayId(), b = newRelayId();
  assert.match(a, /^fr-[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("debugMatch: off unless enabled, windowed and matching", () => {
  const ids = { orderid: "68862341366613893", apTxnId: "2091680468" };
  process.env.AIRPAY2_KKCHAT_DEBUG_ORDER_ID = ids.orderid;
  assert.equal(debugMatch(ids, NOW), null, "flag unset");

  on();
  assert.equal(debugMatch(ids, NOW), "order_id");
  assert.equal(debugMatch({ orderid: "other" }, NOW), null);
  assert.equal(debugMatch({}, NOW), null);

  delete process.env.AIRPAY2_KKCHAT_DEBUG_ORDER_ID;
  process.env.AIRPAY2_KKCHAT_DEBUG_TXN_ID = " 111 , 2091680468 ";
  assert.equal(debugMatch(ids, NOW), "txn_id", "comma list, trimmed");
  assert.equal(debugMatch({ apTxnId: "20916804" }, NOW), null, "exact match only, no prefix");
});

test("debugMatch: the window must be valid, in the future and at most 7 days", () => {
  process.env.AIRPAY2_KKCHAT_DEBUG_ORDER_ID = "O1";
  for (const until of ["", "tomorrow", new Date(NOW - 1).toISOString(), new Date(NOW + 8 * 24 * HOUR).toISOString()]) {
    on(until);
    assert.equal(debugMatch({ orderid: "O1" }, NOW), null, `until=${until}`);
  }
  on(new Date(NOW + 7 * 24 * HOUR).toISOString());
  assert.equal(debugMatch({ orderid: "O1" }, NOW), "order_id");
  for (const flag of ["1", "yes", "TRUE "]) {
    process.env.AIRPAY2_KKCHAT_DEBUG = flag;
    assert.equal(debugMatch({ orderid: "O1" }, NOW), flag.trim().toLowerCase() === "true" ? "order_id" : null, flag);
  }
});

test("debugMatch: at most five ids per list", () => {
  on();
  process.env.AIRPAY2_KKCHAT_DEBUG_ORDER_ID = "a,b,c,d,e,f";
  assert.equal(debugMatch({ orderid: "e" }, NOW), "order_id");
  assert.equal(debugMatch({ orderid: "f" }, NOW), null);
});

test("describeRequest: JSON names, types, bytes and digest of the exact body", () => {
  const body = JSON.stringify({ MERCID: "222222", AMOUNT: "100.00", n: 1, o: { x: 1 }, a: [], z: null });
  const d = describeRequest({ format: "json", headers: {}, body });
  assert.deepEqual(d.field_names, ["MERCID", "AMOUNT", "n", "o", "a", "z"]);
  assert.deepEqual(d.field_types, { MERCID: "string", AMOUNT: "string", n: "number", o: "object", a: "array", z: "null" });
  assert.equal(d.request_bytes, Buffer.byteLength(body));
  assert.equal(d.request_sha256, crypto.createHash("sha256").update(body).digest("hex"));
  assert.ok(!JSON.stringify(d).includes("100.00") && !JSON.stringify(d).includes("222222"), "no values");
});

test("describeRequest: Buffer bodies, multi-byte text, non-object and unparseable JSON", () => {
  const buf = Buffer.from('{"msg":"café"}');
  assert.equal(describeRequest({ format: "json", body: buf }).request_bytes, buf.length);
  assert.equal(describeRequest({ format: "json", body: "[1]" }).body_shape, "array");
  assert.equal(describeRequest({ format: "json", body: "{bad" }).body_shape, "unparseable_json");
});

test("describeRequest: raw form names and duplicate names from the source body", () => {
  const raw = "a=1&b=2&a=3&c=&c=";
  const d = describeRequest({ format: "raw", body: raw }, { rawBody: raw, sourceFormat: "form" });
  assert.deepEqual(d.field_names, ["a", "b", "c"]);
  assert.deepEqual(d.duplicate_field_names, ["a", "c"]);
  assert.equal(describeRequest({ format: "raw", body: "a=1" }, { rawBody: "a=1", sourceFormat: "form" })
    .duplicate_field_names, undefined);
});

test("describeRequest: name lists are bounded", () => {
  const obj = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}_${"x".repeat(50)}`, ""]));
  const d = describeRequest({ format: "json", body: JSON.stringify(obj) });
  assert.equal(d.field_names.length, 60);
  assert.equal(d.field_names_truncated, true);
  assert.ok(d.field_names.every((n) => n.length <= 40));
});

test("safeRequestHeaders keeps only the allowlist plus Content-Length", () => {
  const h = safeRequestHeaders({
    "Content-Type": "application/json", Accept: "application/json", "User-Agent": RELAY_USER_AGENT,
    [RELAY_ID_HEADER]: "fr-1", Authorization: "Bearer SECRET", Cookie: "s=SECRET",
  }, 42);
  assert.deepEqual(Object.keys(h).sort(), ["Accept", "Content-Length", "Content-Type", "User-Agent", RELAY_ID_HEADER].sort());
  assert.equal(h["Content-Length"], "42");
  assert.ok(!JSON.stringify(h).includes("SECRET"));
});

test("safeResponseHeaders: allowlist, cookie names only, Location without query", () => {
  const headers = new Headers([
    ["Server", "nginx/1.22.1"], ["Content-Type", "application/json;charset=ISO-8859-1"],
    ["X-Powered-By", "Servlet/3.1"], ["Set-Cookie", "JSESSIONID=SECRETSESSION; Path=/"],
    ["Set-Cookie", "lb=SECRETLB"], ["Location", "https://kkchat.in/x?token=SECRETQ"],
    ["X-Internal-Debug", "SECRETINTERNAL"],
  ]);
  const h = safeResponseHeaders(headers);
  assert.equal(h.server, "nginx/1.22.1");
  assert.equal(h["x-powered-by"], "Servlet/3.1");
  assert.deepEqual(h.set_cookie_names, ["JSESSIONID", "lb"]);
  assert.equal(h.location, "https://kkchat.in/x");
  assert.equal(h["x-internal-debug"], undefined);
  assert.ok(!JSON.stringify(h).includes("SECRET"));
});

test("resolveHost never throws", async () => {
  const r = await resolveHost("does-not-exist.invalid");
  assert.ok(Array.isArray(r) && r.length >= 1);
});
