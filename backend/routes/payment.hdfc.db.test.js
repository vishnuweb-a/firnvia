// HDFC durable store (HDFC_DB_ENABLED=true): persistence, snapshots, UPI/CARD,
// retries, duplicate webhooks, concurrency, store failures, restart recovery,
// isolation. axios is mocked — no bank, no Supabase, nothing external.
// The fake PostgREST mirrors supabase/migrations/20261118010000_hdfc_persistence.sql;
// the SQL itself is verified by supabase/tests/hdfc_persistence_rollback_test.sql.
//
// Run: node --test routes/payment.hdfc.db.test.js

import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const SB_HOST = "https://fake-hdfc-db.supabase.co";
const SB_KEY = "sb_secret_FAKE_TEST_KEY_123";
const CFG = {
  HDFC_SMARTGATEWAY_ENABLED: "true",
  HDFC_SMARTGATEWAY_ENV: "production",
  HDFC_SMARTGATEWAY_BASE_URL: "https://smartgateway.hdfc.bank.in",
  HDFC_SMARTGATEWAY_MERCHANT_ID: "TESTMID",
  HDFC_SMARTGATEWAY_PAYMENT_PAGE_CLIENT_ID: "TESTMID",
  HDFC_SMARTGATEWAY_API_KEY: "fake-api-key",
  HDFC_SMARTGATEWAY_RESPONSE_KEY: "fake-response-key",
  HDFC_SMARTGATEWAY_RETURN_URL: "https://firvanra.online/payments/hdfc/return",
  HDFC_SMARTGATEWAY_UPI_ONLY: "true",
  HDFC_SMARTGATEWAY_ENABLE_LOGGING: "false",
  HDFC_SMARTGATEWAY_WEBHOOK_USERNAME: "hookuser",
  HDFC_SMARTGATEWAY_WEBHOOK_PASSWORD: "hookpass",
  HDFC_SMARTGATEWAY_SANDBOX_CARD_TEST: "",
  HDFC_DB_ENABLED: "true",
  SUPABASE_URL: SB_HOST,
  SUPABASE_SECRET_KEY: SB_KEY,
  SUPABASE_SERVICE_ROLE_KEY: "",
};
// Set before server.js loads dotenv (which never overrides), so the real .env can't leak in.
Object.assign(process.env, CFG, { VERCEL: "1", FRONTEND_URL: "https://firvanra.online" });

const axios = (await import("axios")).default;
const app = (await import("../server.js")).default;
const { orders } = await import("./orders.js");

// ── fake PostgREST (mirrors the SQL functions) ──────────────────────────────
const db = { orders: [], items: [], attempts: [], history: [] };
let dbDown = false;            // every store call fails (network)
let failRpc = null;            // "hdfc_apply_status" | "hdfc_begin_attempt" | "patch": fail that call once
let beforeBegin = null;        // hook: simulate another instance winning a race
const sbCalls = [];
const UNRESOLVED = ["PENDING", "PENDING_VBV", "AUTHORIZING", "CHARGED"];
const now = () => new Date().toISOString();
const pgErr = (message, code = "P0001", status = 400) =>
  Object.assign(new Error(message), { response: { status, data: { code, message } } });
const netErr = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

function beginAttempt(p) {
  beforeBegin?.(p);
  let o = db.orders.find((x) => x.website_order_id === p.website_order_id);
  const created = !o;
  const amount = Number(p.expected_amount);
  if (!o) o = { id: crypto.randomUUID(), website_order_id: p.website_order_id, merchant_id: p.merchant_id,
    expected_amount: amount, currency: "INR", order_status: "pending", created_at: now(), updated_at: now() };
  if (o.expected_amount !== amount || o.merchant_id !== p.merchant_id || Number(p.transaction_amount) !== amount)
    throw pgErr("hdfc_order_mismatch");
  if (o.order_status === "paid") throw pgErr("hdfc_order_paid");
  let items = [];
  if (!db.items.some((i) => i.order_id === o.id)) {
    items = p.items.map((i) => ({ id: crypto.randomUUID(), order_id: o.id, ...i, total_price: i.unit_price * i.quantity, created_at: now() }));
    if (items.reduce((s, i) => s + i.total_price, 0) !== amount) throw pgErr("hdfc_items_total_mismatch");
  }
  const last = db.attempts.filter((a) => a.order_id === o.id).sort((a, b) => b.attempt_number - a.attempt_number)[0];
  if ((last?.attempt_number ?? 0) !== p.expected_previous_attempt) throw pgErr("hdfc_attempt_conflict");
  if (last && UNRESOLVED.includes(last.transaction_status)) throw pgErr("hdfc_attempt_unresolved");
  if (db.attempts.some((a) => a.hdfc_order_id === p.hdfc_order_id)) throw pgErr("duplicate key", "23505", 409);
  const a = { id: crypto.randomUUID(), order_id: o.id, hdfc_order_id: p.hdfc_order_id, hdfc_transaction_id: null,
    attempt_number: (last?.attempt_number ?? 0) + 1, payment_method_type: "UNKNOWN", payment_method: null,
    transaction_amount: amount, currency: "INR", transaction_status: "NEW", hdfc_status_id: null, error_code: null,
    conflicted: false, gateway_environment: p.gateway_environment, verified_at: null, customer_ref: p.customer_ref,
    provider_order_ref: null, allowed_payment_methods: p.allowed_payment_methods, provider_created_at: null,
    provider_updated_at: null, session_error: null, conflict_reason: null, created_at: now(), updated_at: now() };
  if (created) db.orders.push(o);
  db.items.push(...items);
  db.attempts.push(a);
  db.history.push({ payment_attempt_id: a.id, previous_status: null, new_status: "NEW", event_source: "session_create", event_timestamp: now() });
  o.order_status = "pending";
  return { attempt_number: a.attempt_number };
}

function applyStatus(p) {
  const a = db.attempts.find((x) => x.hdfc_order_id === p.hdfc_order_id);
  if (!a) throw pgErr("hdfc_attempt_not_found");
  const v = p.transaction_status;
  if (a.transaction_status !== p.expected_status || (a.transaction_status === "CHARGED" && !["CHARGED", "AUTO_REFUNDED"].includes(v)))
    return { applied: false, current: a.transaction_status };
  const verified = Boolean(p.verified) && v === "CHARGED";
  const prev = a.transaction_status;
  Object.assign(a, {
    transaction_status: v,
    hdfc_status_id: p.hdfc_status_id ?? a.hdfc_status_id,
    payment_method_type: p.payment_method_type ?? a.payment_method_type,
    payment_method: p.payment_method ?? a.payment_method,
    hdfc_transaction_id: p.hdfc_transaction_id ?? a.hdfc_transaction_id,
    error_code: p.error_code ?? null,
    provider_created_at: a.provider_created_at ?? p.provider_created_at,
    provider_updated_at: p.provider_updated_at ?? a.provider_updated_at,
    conflicted: a.conflicted || Boolean(p.conflicted),
    conflict_reason: a.conflict_reason ?? p.conflict_reason,
    verified_at: verified ? (a.verified_at ?? now()) : null,
    updated_at: now(),
  });
  if (v !== prev) db.history.push({ payment_attempt_id: a.id, previous_status: prev, new_status: v,
    event_source: p.event_source, event_timestamp: p.provider_updated_at ?? now() });
  const o = db.orders.find((x) => x.id === a.order_id);
  const latest = Math.max(...db.attempts.filter((x) => x.order_id === o.id).map((x) => x.attempt_number));
  if (verified) o.order_status = "paid";
  else if (["pending", "failed"].includes(p.order_status) && a.attempt_number === latest && o.order_status !== "paid")
    o.order_status = p.order_status;
  return { applied: true, changed: v !== prev };
}

const embed = (o) => ({ ...o, hdfc_order_items: db.items.filter((i) => i.order_id === o.id),
  hdfc_payment_attempts: db.attempts.filter((a) => a.order_id === o.id) });
const eq = (u, col) => { const v = u.searchParams.get(col); return v?.startsWith("eq.") ? v.slice(3) : null; };

async function supabase(method, url, body, opts) {
  sbCalls.push({ method, url, body, headers: opts?.headers });
  assert.equal(opts.headers.apikey, SB_KEY);
  assert.equal(opts.headers.Authorization, `Bearer ${SB_KEY}`);
  assert.ok(opts.timeout > 0, "store calls are bounded");
  if (dbDown) throw netErr();
  const u = new URL(url);
  const path = u.pathname.replace("/rest/v1", "");
  const once = (name) => { if (failRpc === name) { failRpc = null; throw netErr(); } };
  if (method === "POST" && path === "/rpc/hdfc_begin_attempt") { once("hdfc_begin_attempt"); return { data: beginAttempt(structuredClone(body.p)) }; }
  if (method === "POST" && path === "/rpc/hdfc_apply_status") { once("hdfc_apply_status"); return { data: applyStatus(structuredClone(body.p)) }; }
  if (method === "PATCH" && path === "/hdfc_payment_attempts") {
    once("patch");
    const a = db.attempts.find((x) => x.hdfc_order_id === eq(u, "hdfc_order_id"));
    if (a) Object.assign(a, body);
    return { data: "" };
  }
  if (method === "GET" && path === "/hdfc_payment_attempts") {
    const a = db.attempts.find((x) => x.hdfc_order_id === eq(u, "hdfc_order_id"));
    return { data: a ? [{ hdfc_orders: { website_order_id: db.orders.find((o) => o.id === a.order_id).website_order_id } }] : [] };
  }
  if (method === "GET" && path === "/hdfc_orders") {
    const o = db.orders.find((x) => x.website_order_id === eq(u, "website_order_id"));
    return { data: structuredClone(o ? [embed(o)] : []) };
  }
  throw new Error(`unexpected store call ${method} ${url}`);
}

// ── HDFC mock ───────────────────────────────────────────────────────────────
const calls = [];               // every external call, in order (HDFC + store)
const book = new Map();
let sessionBehaviour = null;
const isSb = (url) => url.startsWith(SB_HOST);

mock.method(axios, "post", async (url, body, opts) => {
  calls.push({ method: "POST", url, opts });
  if (isSb(url)) return supabase("POST", url, body, opts);
  const host = ["smartgateway.hdfc.bank.in", "smartgateway.hdfcuat.bank.in"].find((h) => url === `https://${h}/session`);
  if (host) {
    if (sessionBehaviour) return sessionBehaviour(body);
    book.set(body.order_id, { order_id: body.order_id, status: "NEW", status_id: 10, amount: Number(body.amount), currency: "INR", merchant_id: "TESTMID" });
    return { data: { status: "NEW", id: `ordeh_${body.order_id}`, order_id: body.order_id,
      payment_links: { web: `https://${host}/orders/ordeh_x/payment-page` } } };
  }
  throw new Error(`unexpected axios.post ${url}`);
});
mock.method(axios, "patch", async (url, body, opts) => {
  calls.push({ method: "PATCH", url });
  if (isSb(url)) return supabase("PATCH", url, body, opts);
  throw new Error(`unexpected axios.patch ${url}`);
});
mock.method(axios, "get", async (url, opts) => {
  calls.push({ method: "GET", url, opts });
  if (isSb(url)) return supabase("GET", url, null, opts);
  const id = decodeURIComponent(url.split("/orders/")[1] || "");
  const entry = book.get(id);
  if (typeof entry === "function") return entry();
  if (!entry) { const e = new Error("nf"); e.response = { status: 404 }; throw e; }
  return { data: entry };
});

let server, base;
before(async () => {
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { mock.restoreAll(); await new Promise((r) => server.close(r)); });
beforeEach(() => {
  calls.length = 0; sbCalls.length = 0; sessionBehaviour = null; dbDown = false; failRpc = null; beforeBegin = null;
  Object.assign(process.env, CFG);
});

// ── helpers ─────────────────────────────────────────────────────────────────
const BUYER = { firstName: "Asha Rao", email: "asha.rao@example.com", phone: "+91 98765 43210" };
const post = (path, body, headers = {}) => fetch(base + path, {
  method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
// Real catalog products via the real order route: 2 x 499 + 1 x 999 = 1997.
async function createOrder(items = [{ id: "technical-website-audit", qty: 2 }, { id: "wordpress-care", qty: 1 }]) {
  const res = await post("/api/orders", { items, buyer: BUYER });
  assert.equal(res.status, 200);
  return (await res.json()).id;
}
const initiate = (orderId) => post("/api/payment/hdfc/initiate", { orderId });
const getOrder = async (id) => { const r = await fetch(`${base}/api/orders/${id}`); return { status: r.status, body: await r.json() }; };
function sign(params) {
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", CFG.HDFC_SMARTGATEWAY_RESPONSE_KEY).update(encodeURIComponent(str)).digest("base64");
}
const postReturn = (hdfcOrderId, status = "CHARGED") => {
  const p = { order_id: hdfcOrderId, status, status_id: "21" };
  return fetch(`${base}/payments/hdfc/return`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...p, signature: sign(p), signature_algorithm: "HMAC-SHA256" }).toString() });
};
const webhook = (hdfcOrderId) => post("/api/webhooks/hdfc",
  { id: "evt", event_name: "ORDER_SUCCEEDED", content: { order: { order_id: hdfcOrderId, status: "CHARGED" } } },
  { Authorization: "Basic " + Buffer.from("hookuser:hookpass").toString("base64") });
const record = (id, over = {}) => ({ order_id: id, status: "CHARGED", status_id: 21, amount: 1997, effective_amount: 1997,
  currency: "INR", merchant_id: "TESTMID", payment_method_type: "UPI", payment_method: "UPI_COLLECT", txn_id: `${id}-1`,
  date_created: "2026-11-18T09:00:00Z", last_updated: "2026-11-18T09:01:00Z", ...over });

const dbOrder = (id) => db.orders.find((o) => o.website_order_id === id);
const dbAttempts = (id) => db.attempts.filter((a) => a.order_id === dbOrder(id)?.id).sort((a, b) => a.attempt_number - b.attempt_number);
const dbAttempt = (hdfcId) => db.attempts.find((a) => a.hdfc_order_id === hdfcId);
const dbHistory = (hdfcId) => db.history.filter((h) => h.payment_attempt_id === dbAttempt(hdfcId)?.id);
const restart = () => orders.clear(); // new Vercel instance: process memory gone

async function started(items) {
  const id = await createOrder(items);
  const res = await initiate(id);
  assert.equal(res.status, 200, await res.clone().text());
  return { id, hdfcId: dbAttempts(id).at(-1).hdfc_order_id, body: await res.json() };
}

// ── order persistence + product snapshot ────────────────────────────────────
test("checkout persists the website order and an exact catalog product snapshot", async () => {
  const { id, hdfcId } = await started();
  const o = dbOrder(id);
  assert.equal(o.expected_amount, 1997);
  assert.equal(o.merchant_id, "TESTMID");
  assert.equal(o.currency, "INR");
  assert.equal(o.order_status, "pending");
  const items = db.items.filter((i) => i.order_id === o.id).map(({ product_name, product_type, sku, quantity, unit_price, total_price }) =>
    ({ product_name, product_type, sku, quantity, unit_price, total_price }));
  assert.deepEqual(items, [
    { product_name: "Technical Website Audit", product_type: "service", sku: "technical-website-audit", quantity: 2, unit_price: 499, total_price: 998 },
    { product_name: "WordPress Care Service", product_type: "service", sku: "wordpress-care", quantity: 1, unit_price: 999, total_price: 999 },
  ]);
  // Website order id and HDFC order id are stored separately.
  const a = dbAttempt(hdfcId);
  assert.notEqual(a.hdfc_order_id, id);
  assert.equal(o.website_order_id, id);
  assert.equal(a.attempt_number, 1);
  assert.equal(a.transaction_amount, 1997);
  assert.equal(a.gateway_environment, "production");
  assert.deepEqual(a.allowed_payment_methods, ["UPI"]);
  assert.match(a.customer_ref, /^c[0-9a-f]{19}$/);
  assert.equal(a.provider_order_ref, `ordeh_${hdfcId}`);
  assert.deepEqual(dbHistory(hdfcId).map((h) => [h.previous_status, h.new_status, h.event_source]), [[null, "NEW", "session_create"]]);
});

test("write-ahead: the attempt is durable BEFORE HDFC's session is created", async () => {
  await started();
  const begin = calls.findIndex((c) => c.url.endsWith("/rpc/hdfc_begin_attempt"));
  const session = calls.findIndex((c) => c.url.endsWith("/session"));
  assert.ok(begin >= 0 && session > begin, "begin_attempt precedes POST /session");
});

test("snapshot never invents product details: an item not in the catalog refuses the payment", async () => {
  const id = await createOrder();
  orders.get(id).items[0].id = "not-a-product";
  assert.equal((await initiate(id)).status, 503);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 0);
  assert.equal(dbOrder(id), undefined);
});

// ── success / failure / pending, UPI + CARD ─────────────────────────────────
test("successful UPI payment: verified CHARGED with txn, method, timestamps; history; order paid", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId));
  assert.equal((await postReturn(hdfcId)).status, 303);
  const a = dbAttempt(hdfcId);
  assert.equal(a.transaction_status, "CHARGED");
  assert.equal(a.hdfc_status_id, 21);
  assert.equal(a.payment_method_type, "UPI");
  assert.equal(a.payment_method, "UPI_COLLECT");
  assert.equal(a.hdfc_transaction_id, `${hdfcId}-1`);
  assert.equal(a.provider_created_at, "2026-11-18T09:00:00.000Z");
  assert.equal(a.provider_updated_at, "2026-11-18T09:01:00.000Z");
  assert.ok(a.verified_at);
  assert.equal(a.conflicted, false);
  assert.equal(dbOrder(id).order_status, "paid");
  assert.deepEqual(dbHistory(hdfcId).map((h) => [h.previous_status, h.new_status, h.event_source]),
    [[null, "NEW", "session_create"], ["NEW", "CHARGED", "return_url"]]);
  assert.equal(dbHistory(hdfcId)[1].event_timestamp, "2026-11-18T09:01:00.000Z");
});

test("failed payment: status, bank error code and history recorded; order failed", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "AUTHORIZATION_FAILED", status_id: 27, bank_error_code: "U30", txn_id: `${hdfcId}-1` }));
  assert.equal((await webhook(hdfcId)).status, 200);
  const a = dbAttempt(hdfcId);
  assert.equal(a.transaction_status, "AUTHORIZATION_FAILED");
  assert.equal(a.error_code, "U30");
  assert.equal(a.verified_at, null);
  assert.equal(dbOrder(id).order_status, "failed");
  assert.deepEqual(dbHistory(hdfcId).at(-1), { ...dbHistory(hdfcId).at(-1), previous_status: "NEW", new_status: "AUTHORIZATION_FAILED", event_source: "webhook" });
});

test("pending payment is recorded and not treated as paid", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "PENDING_VBV", status_id: 23 }));
  await postReturn(hdfcId);
  assert.equal(dbAttempt(hdfcId).transaction_status, "PENDING_VBV");
  assert.equal(dbAttempt(hdfcId).verified_at, null);
  assert.equal(dbOrder(id).order_status, "pending");
});

test("CARD (UAT card-test mode): allowed methods and CARD charge recorded, not flagged", async () => {
  Object.assign(process.env, { HDFC_SMARTGATEWAY_ENV: "sandbox", HDFC_SMARTGATEWAY_BASE_URL: "https://smartgateway.hdfcuat.bank.in",
    HDFC_SMARTGATEWAY_SANDBOX_CARD_TEST: "true" });
  const { id, hdfcId } = await started();
  const a = dbAttempt(hdfcId);
  assert.deepEqual(a.allowed_payment_methods, ["UPI", "CARD"]);
  assert.equal(a.gateway_environment, "sandbox");
  // Sensitive card / payer fields in the provider record must never be stored.
  book.set(hdfcId, record(hdfcId, { payment_method_type: "CARD", payment_method: "VISA",
    card: { card_number: "4111111111111111", last_four_digits: "1111", expiry_month: "12", name_on_card: "ASHA RAO" },
    payer_vpa: "asha@okhdfc", customer_email: BUYER.email, customer_phone: "9876543210" }));
  await webhook(hdfcId);
  assert.equal(dbAttempt(hdfcId).payment_method_type, "CARD");
  assert.equal(dbAttempt(hdfcId).payment_method, "VISA");
  assert.equal(dbAttempt(hdfcId).conflicted, false);
  assert.equal(dbOrder(id).order_status, "paid");
  const stored = JSON.stringify(db);
  for (const s of ["4111111111111111", "ASHA RAO", "asha@okhdfc", BUYER.email, "9876543210", "Asha", "fake-api-key"])
    assert.ok(!stored.includes(s), `stored sensitive value: ${s}`);
});

test("production: a CARD charge is settled but flagged as non_upi conflict", async () => {
  const { hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { payment_method_type: "CARD" }));
  await webhook(hdfcId);
  assert.equal(dbAttempt(hdfcId).conflicted, true);
  assert.equal(dbAttempt(hdfcId).conflict_reason, "non_upi");
});

test("amount mismatch never pays; attempt flagged mismatch_amount", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { amount: 1, effective_amount: 1 }));
  await postReturn(hdfcId);
  assert.equal(dbOrder(id).order_status, "pending");
  assert.equal(dbAttempt(hdfcId).verified_at, null);
  assert.equal(dbAttempt(hdfcId).conflict_reason, "mismatch_amount");
});

// ── retries ─────────────────────────────────────────────────────────────────
test("retry after failure: attempt 2 recorded, attempt 1 preserved, snapshot not duplicated", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "AUTHENTICATION_FAILED" }));
  assert.equal((await initiate(id)).status, 200);
  const [a1, a2] = dbAttempts(id);
  assert.equal(a1.hdfc_order_id, hdfcId);
  assert.equal(a1.transaction_status, "AUTHENTICATION_FAILED");
  assert.equal(a2.attempt_number, 2);
  assert.notEqual(a2.hdfc_order_id, hdfcId);
  assert.equal(db.items.filter((i) => i.order_id === dbOrder(id).id).length, 2);
  assert.equal(dbHistory(hdfcId).at(-1).event_source, "reconciliation");
  book.set(a2.hdfc_order_id, record(a2.hdfc_order_id));
  await webhook(a2.hdfc_order_id);
  assert.equal(dbOrder(id).order_status, "paid");
  assert.equal((await initiate(id)).status, 409, "paid order cannot be charged again");
});

test("retry blocked while the previous attempt is in flight", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "AUTHORIZING" }));
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
});

test("retry finds the previous attempt CHARGED: settles, never charges twice", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId));
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
  assert.equal(dbOrder(id).order_status, "paid");
});

// ── duplicate callbacks ─────────────────────────────────────────────────────
test("duplicate webhooks and returns are idempotent: one transition, no duplicate history", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId));
  for (const r of await Promise.all([webhook(hdfcId), webhook(hdfcId), postReturn(hdfcId)])) assert.ok([200, 303, 503].includes(r.status));
  for (let i = 0; i < 3; i++) assert.equal((await webhook(hdfcId)).status, 200); // HDFC re-sends until 200
  assert.equal((await postReturn(hdfcId)).status, 303);
  const verifiedAt = dbAttempt(hdfcId).verified_at;
  await webhook(hdfcId);
  assert.equal(dbAttempt(hdfcId).verified_at, verifiedAt);
  assert.deepEqual(dbHistory(hdfcId).map((h) => h.new_status), ["NEW", "CHARGED"]);
  assert.equal(dbOrder(id).order_status, "paid");
});

test("late failure for a paid order never downgrades it", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId));
  await webhook(hdfcId);
  book.set(hdfcId, record(hdfcId, { status: "AUTHORIZATION_FAILED" }));
  await webhook(hdfcId);
  assert.equal(dbOrder(id).order_status, "paid");
  assert.equal(dbAttempt(hdfcId).transaction_status, "CHARGED");
});

// ── concurrency ─────────────────────────────────────────────────────────────
test("concurrent initiation (same instance): exactly one HDFC session", async () => {
  const id = await createOrder();
  const results = await Promise.all([initiate(id), initiate(id), initiate(id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 1);
  assert.equal(dbAttempts(id).length, 1);
});

test("concurrent initiation (another instance won the race): 409, no HDFC session", async () => {
  const id = await createOrder();
  beforeBegin = (p) => { beforeBegin = null; beginAttempt({ ...p, hdfc_order_id: "FIRotherinstance1" }); };
  const res = await initiate(id);
  assert.equal(res.status, 409);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 0);
  assert.deepEqual(dbAttempts(id).map((a) => a.hdfc_order_id), ["FIRotherinstance1"]);
});

test("an attempt whose session may still be in flight elsewhere blocks a new one", async () => {
  const id = await createOrder();
  // Another instance recorded attempt 1 and is still calling HDFC (HDFC has no record yet).
  beginAttempt({ website_order_id: id, merchant_id: "TESTMID", expected_amount: "1997.00", transaction_amount: "1997.00",
    gateway_environment: "production", customer_ref: "cx", allowed_payment_methods: ["UPI"], hdfc_order_id: "FIRinflight1",
    expected_previous_attempt: 0, items: [{ product_name: "Technical Website Audit", product_type: "service", sku: "technical-website-audit", quantity: 2, unit_price: 499 },
      { product_name: "WordPress Care Service", product_type: "service", sku: "wordpress-care", quantity: 1, unit_price: 999 }] });
  assert.equal((await initiate(id)).status, 409);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 0);
  // Hours later, still 404 at HDFC: the session may have been issued before a crash. Still blocked.
  dbAttempt("FIRinflight1").created_at = new Date(Date.now() - 6 * 3600e3).toISOString();
  restart();
  assert.equal((await initiate(id)).status, 409);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 0);
  assert.equal(dbAttempts(id).length, 1);
});

// ── duplicate-payment hardening ─────────────────────────────────────────────
const aged = (hdfcId, ms) => { dbAttempt(hdfcId).created_at = new Date(Date.now() - ms).toISOString(); };
const sessions = () => calls.filter((c) => c.url.endsWith("/session")).length;

test("retry after 60s: an issued, unpaid link (NEW) never authorizes a retry; it can still settle", async () => {
  const { id, hdfcId } = await started();
  for (const ms of [61e3, 15 * 60e3, 24 * 3600e3]) {
    aged(hdfcId, ms);
    calls.length = 0;
    assert.equal((await initiate(id)).status, 409);
    assert.equal(sessions(), 0);
  }
  for (const status of ["STARTED", "PENDING", "PENDING_VBV", "AUTHORIZING", "AUTHORIZED", "SOMETHING_NEW"]) {
    book.set(hdfcId, record(hdfcId, { status }));
    assert.equal((await initiate(id)).status, 409, status);
  }
  assert.equal(dbAttempts(id).length, 1);
  book.set(hdfcId, record(hdfcId)); // the customer paid on the original page after all
  assert.equal((await webhook(hdfcId)).status, 200);
  assert.equal(dbOrder(id).order_status, "paid");
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
});

test("Order Status unavailable/unparseable on retry: blocked with 503, no session, attempt intact", async () => {
  const { id, hdfcId } = await started();
  aged(hdfcId, 10 * 60e3);
  for (const fail of [() => { throw netErr(); }, () => { const e = new Error("t"); e.code = "ECONNABORTED"; throw e; },
    () => { const e = new Error("s"); e.response = { status: 500 }; throw e; }, () => ({ data: "<html>" })]) {
    book.set(hdfcId, fail);
    calls.length = 0;
    assert.equal((await initiate(id)).status, 503);
    assert.equal(sessions(), 0);
  }
  assert.equal(dbAttempts(id).length, 1);
  assert.equal(dbAttempt(hdfcId).transaction_status, "NEW");
});

test("ambiguous session timeout: link never issued, so a verified-NEW or 404 prior attempt permits retry", async () => {
  const id = await createOrder();
  // HDFC created the order but our call timed out: no link reached the customer.
  sessionBehaviour = (body) => { book.set(body.order_id, record(body.order_id, { status: "NEW", txn_id: undefined }));
    const e = new Error("t"); e.code = "ECONNABORTED"; throw e; };
  const warn = mock.method(console, "warn", () => {});
  try { assert.equal((await initiate(id)).status, 502); } finally { warn.mock.restore(); }
  const first = dbAttempts(id)[0];
  assert.equal(first.session_error, "timeout");
  sessionBehaviour = null;
  calls.length = 0;
  assert.equal((await initiate(id)).status, 200);
  assert.ok(calls.findIndex((c) => c.url.endsWith(`/orders/${first.hdfc_order_id}`)) <
    calls.findIndex((c) => c.url.endsWith("/session")), "previous attempt checked with HDFC first");
  assert.deepEqual(dbAttempts(id).map((a) => a.attempt_number), [1, 2]);
});

test("ambiguous session timeout but HDFC shows payment activity: blocked", async () => {
  const id = await createOrder();
  sessionBehaviour = (body) => { book.set(body.order_id, record(body.order_id, { status: "PENDING_VBV" }));
    const e = new Error("t"); e.code = "ECONNABORTED"; throw e; };
  const warn = mock.method(console, "warn", () => {});
  try { await initiate(id); } finally { warn.mock.restore(); }
  sessionBehaviour = null;
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
});

test("session error could not be recorded: retry stays blocked (safe side)", async () => {
  const id = await createOrder();
  sessionBehaviour = () => { const e = new Error("x"); e.response = { status: 500, data: {} }; throw e; };
  failRpc = "patch";
  const quiet = [mock.method(console, "warn", () => {}), mock.method(console, "error", () => {})];
  try { assert.equal((await initiate(id)).status, 502); } finally { quiet.forEach((m) => m.mock.restore()); }
  sessionBehaviour = null;
  assert.equal(dbAttempts(id)[0].session_error, null);
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
});

test("crash after write-ahead, before session: restart + any delay never permits a retry", async () => {
  const id = await createOrder();
  const crash = mock.method(axios, "post", async (url, body, opts) => {
    if (url.endsWith("/session")) throw Object.assign(new Error("FUNCTION_INVOCATION_TIMEOUT"), { code: "ECONNRESET" });
    return supabase("POST", url, body, opts);
  });
  // Simulate the process dying mid-session: the session error is never written.
  failRpc = "patch";
  const quiet = [mock.method(console, "warn", () => {}), mock.method(console, "error", () => {})];
  try { await initiate(id); } finally { crash.mock.restore(); quiet.forEach((m) => m.mock.restore()); }
  const hdfcId = dbAttempts(id)[0].hdfc_order_id;
  restart();
  aged(hdfcId, 48 * 3600e3);
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
});

test("mismatched previous attempt blocks a retry", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "AUTHORIZATION_FAILED", merchant_id: "OTHERMID" }));
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 1);
});

test("two instances retry after a failure at once: exactly one new attempt, one session", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "AUTHORIZATION_FAILED" }));
  // The other instance reconciled the same failure and committed attempt 2 first.
  beforeBegin = (p) => { beforeBegin = null; beginAttempt({ ...p, hdfc_order_id: "FIRotherinstance2" }); };
  calls.length = 0;
  assert.equal((await initiate(id)).status, 409);
  assert.equal(sessions(), 0);
  assert.deepEqual(dbAttempts(id).map((a) => [a.attempt_number, a.hdfc_order_id]), [[1, hdfcId], [2, "FIRotherinstance2"]]);
  // A third request now sees attempt 2 (open at HDFC as far as we know) and is refused.
  assert.equal((await initiate(id)).status, 409);
  assert.equal(dbAttempts(id).length, 2);
});

test("stale memory on another instance: store says paid, initiation refused before HDFC", async () => {
  const { id, hdfcId } = await started();
  dbAttempt(hdfcId).transaction_status = "CHARGED";
  dbAttempt(hdfcId).verified_at = now();
  dbOrder(id).order_status = "paid";           // settled by another instance
  orders.get(id).status = "failed";            // this instance never heard
  calls.length = 0;
  assert.equal((await initiate(id)).status, 409);
  assert.equal(calls.filter((c) => !isSb(c.url)).length, 0, "no HDFC call at all");
  assert.equal(dbAttempts(id).length, 1);
});

test("public order endpoint: no buyer contact or attempt internals; paid refs only once paid", async () => {
  const { id, hdfcId } = await started();
  const pending = (await getOrder(id)).body;
  assert.deepEqual(Object.keys(pending).sort(), ["createdAt", "gateway", "id", "items", "status", "total"]);
  const text = JSON.stringify(pending);
  for (const s of [BUYER.email, "98765", "Asha", hdfcId, "customer", SB_KEY]) assert.ok(!text.includes(s), s);
  book.set(hdfcId, record(hdfcId));
  await webhook(hdfcId);
  const paid = (await getOrder(id)).body;
  assert.equal(paid.hdfcPaidOrderId, hdfcId);
  assert.ok(!JSON.stringify(paid).includes(BUYER.email));
});

// ── store failures ──────────────────────────────────────────────────────────
test("store down: no payment is initiated (503, zero HDFC calls)", async () => {
  const id = await createOrder();
  dbDown = true;
  const res = await initiate(id);
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.ok(!text.includes(SB_KEY) && !text.includes("supabase"));
  assert.equal(calls.filter((c) => !isSb(c.url)).length, 0);
});

test("begin write fails: no payment is initiated", async () => {
  const id = await createOrder();
  failRpc = "hdfc_begin_attempt";
  assert.equal((await initiate(id)).status, 503);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 0);
});

test("session fails: attempt marked with session_error; immediate retry allowed", async () => {
  const id = await createOrder();
  sessionBehaviour = () => { const e = new Error("x"); e.response = { status: 401, data: {} }; throw e; };
  const warn = mock.method(console, "warn", () => {});
  try { assert.equal((await initiate(id)).status, 502); } finally { warn.mock.restore(); }
  assert.equal(dbAttempts(id)[0].session_error, "http_401");
  sessionBehaviour = null;
  assert.equal((await initiate(id)).status, 200);
  assert.equal(dbAttempts(id).length, 2);
});

test("crash-safe: session succeeds but the follow-up write fails; customer still pays and it settles", async () => {
  const id = await createOrder();
  failRpc = "patch";
  const res = await initiate(id);
  assert.equal(res.status, 200, "customer gets the payment link");
  const hdfcId = dbAttempts(id)[0].hdfc_order_id;
  assert.equal(dbAttempt(hdfcId).provider_order_ref, null);
  restart();
  book.set(hdfcId, record(hdfcId));
  assert.equal((await webhook(hdfcId)).status, 200);
  assert.equal(dbOrder(id).order_status, "paid");
});

test("status write fails: webhook answers 503 so HDFC retries; retry persists", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId));
  failRpc = "hdfc_apply_status";
  assert.equal((await webhook(hdfcId)).status, 503);
  assert.equal(dbOrder(id).order_status, "pending");
  assert.equal((await webhook(hdfcId)).status, 200);
  assert.equal(dbOrder(id).order_status, "paid");
  assert.deepEqual(dbHistory(hdfcId).map((h) => h.new_status), ["NEW", "CHARGED"]);
});

test("store down on webhook: 503 (HDFC re-sends), never 404", async () => {
  const { hdfcId } = await started();
  restart();
  dbDown = true;
  assert.equal((await webhook(hdfcId)).status, 503);
});

test("store down on return after restart: 503 page, no guessing", async () => {
  const { hdfcId } = await started();
  restart();
  dbDown = true;
  assert.equal((await postReturn(hdfcId)).status, 503);
});

test("store down on order page: in-memory copy still served", async () => {
  const { id } = await started();
  dbDown = true;
  const r = await getOrder(id);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, id);
});

// ── restart recovery ────────────────────────────────────────────────────────
test("restart: return URL resolves the order from the store and settles it", async () => {
  const { id, hdfcId } = await started();
  restart();
  book.set(hdfcId, record(hdfcId));
  const res = await postReturn(hdfcId);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `https://firvanra.online/order/${id}?status=pending&gateway=hdfc&returnStatus=success`);
  assert.equal(dbOrder(id).order_status, "paid");
});

test("restart: order page recovers items, total and status, and settles a delayed payment", async () => {
  const { id, hdfcId } = await started();
  restart();
  const r1 = await getOrder(id);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, "pending");
  assert.equal(r1.body.total, 1997);
  assert.deepEqual(r1.body.items.map((i) => [i.id, i.title, i.price, i.qty]),
    [["technical-website-audit", "Technical Website Audit", 499, 2], ["wordpress-care", "WordPress Care Service", 999, 1]]);
  book.set(hdfcId, record(hdfcId));
  restart(); // bypass the per-attempt poll throttle the way a fresh instance would
  const r2 = await getOrder(id);
  assert.equal(r2.body.status, "paid");
  assert.equal(r2.body.hdfcPaidOrderId, hdfcId);
  assert.equal(dbHistory(hdfcId).at(-1).event_source, "order_status_api");
  assert.ok(!JSON.stringify(r2.body).includes(SB_KEY));
});

test("restart: retry on a recovered order is refused safely (no buyer contact is stored)", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "JUSPAY_DECLINED" }));
  restart();
  // Previous attempt is still reconciled and persisted; then 400 (email/phone are never stored).
  calls.length = 0;
  const res = await initiate(id);
  assert.equal(res.status, 400);
  assert.equal(calls.filter((c) => c.url.endsWith("/session")).length, 0);
  assert.equal(dbAttempts(id).length, 1);
  assert.equal(dbAttempt(hdfcId).transaction_status, "JUSPAY_DECLINED");
  assert.equal(dbOrder(id).order_status, "failed");
});

test("second CHARGED attempt on a paid order is flagged duplicate_charge", async () => {
  const { id, hdfcId } = await started();
  book.set(hdfcId, record(hdfcId, { status: "AUTHORIZATION_FAILED" }));
  await initiate(id);
  const second = dbAttempts(id)[1].hdfc_order_id;
  book.set(second, record(second));
  await webhook(second);
  book.set(hdfcId, record(hdfcId)); // first attempt later captured too
  await webhook(hdfcId);
  assert.equal(dbOrder(id).order_status, "paid");
  assert.equal(dbAttempt(hdfcId).conflict_reason, "duplicate_charge");
});

// ── isolation ───────────────────────────────────────────────────────────────
test("flag off: the HDFC flow makes zero store calls (live behaviour unchanged)", async () => {
  process.env.HDFC_DB_ENABLED = "false";
  const id = await createOrder();
  assert.equal((await initiate(id)).status, 200);
  const hdfcId = orders.get(id).hdfcOrderId;
  book.set(hdfcId, record(hdfcId));
  await postReturn(hdfcId);
  await webhook(hdfcId);
  await getOrder(id);
  assert.equal(orders.get(id).status, "paid");
  assert.equal(sbCalls.length, 0);
  assert.equal(dbOrder(id), undefined);
});

test("other gateways' orders never touch the HDFC store", async () => {
  const id = await createOrder();
  orders.get(id).gateway = "airpay";
  assert.equal((await getOrder(id)).status, 200);
  assert.equal((await post("/api/payment/payu/initiate", {})).status, 400);
  assert.equal((await post("/api/payment/sabpaisa/initiate", {})).status, 400);
  assert.equal((await post("/api/payment/airpay-2/initiate", {})).status, 400);
  assert.equal(sbCalls.length, 0);
});

test("store key is never sent anywhere but the store", async () => {
  const { hdfcId } = await started();
  book.set(hdfcId, record(hdfcId));
  await webhook(hdfcId);
  const nonStore = calls.filter((c) => !isSb(c.url));
  assert.ok(nonStore.length >= 2);
  for (const c of nonStore) assert.ok(!JSON.stringify(c.opts || {}).includes(SB_KEY), c.url);
  assert.ok(sbCalls.every((c) => c.url.startsWith(`${SB_HOST}/rest/v1/`)));
});
