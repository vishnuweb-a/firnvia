// HDFC SmartGateway ("UPI — HDFC"): flag, config, session, UPI-only filter,
// return signature, Order Status authority, webhook auth, idempotency, retries.
// axios is mocked: nothing external is contacted. Fake credentials only.
//
// Run: node --test routes/payment.hdfc.test.js

import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

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
};
Object.assign(process.env, CFG, { VERCEL: "1", FRONTEND_URL: "https://firvanra.online" });

const axios = (await import("axios")).default;
const app = (await import("../server.js")).default;
const { orders } = await import("./orders.js");
const { verifyReturnSignature, UPI_ONLY_PAYMENT_FILTER, classifyHdfcStatus } =
  await import("../services/hdfc.js");

// ── HDFC mock ───────────────────────────────────────────────────────────────
const calls = [];
const book = new Map();      // hdfc order_id -> Order Status record | function
let sessionBehaviour = null;

mock.method(axios, "post", async (url, body, opts) => {
  calls.push({ method: "POST", url, body, headers: opts?.headers });
  if (url === "https://smartgateway.hdfc.bank.in/session") {
    if (sessionBehaviour) return sessionBehaviour(body);
    book.set(body.order_id, { order_id: body.order_id, status: "NEW", status_id: 10, amount: Number(body.amount), currency: "INR", merchant_id: "TESTMID" });
    return { data: { status: "NEW", id: "ordeh_x", order_id: body.order_id,
      payment_links: { web: `https://smartgateway.hdfc.bank.in/orders/ordeh_x/payment-page` } } };
  }
  throw new Error(`unexpected axios.post ${url}`);
});
mock.method(axios, "get", async (url, opts) => {
  calls.push({ method: "GET", url, headers: opts?.headers });
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
beforeEach(() => { calls.length = 0; sessionBehaviour = null; Object.assign(process.env, CFG); });

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
function localOrder({ total = 849, phone = "+91 90000 00000" } = {}) {
  const id = `FIR-h${Date.now().toString(36)}${++seq}`;
  const order = { id, total, items: [{ id: "p", title: "T", price: total, qty: 1 }],
    buyer: { firstName: "Asha Rao", email: "a@b.co", phone }, status: "pending", createdAt: new Date().toISOString() };
  orders.set(id, order);
  return order;
}
const post = (path, body, headers = {}) => fetch(base + path, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const initiate = (orderId, extra = {}) => post("/api/payment/hdfc/initiate", { orderId, ...extra });
const getOrder = async (id) => (await fetch(`${base}/api/orders/${id}`)).json();

function sign(params, key = CFG.HDFC_SMARTGATEWAY_RESPONSE_KEY) {
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", key).update(encodeURIComponent(str)).digest("base64");
}
function returnForm(hdfcOrderId, status = "CHARGED", statusId = "21", key) {
  const p = { order_id: hdfcOrderId, status, status_id: statusId };
  return new URLSearchParams({ ...p, signature: sign(p, key), signature_algorithm: "HMAC-SHA256" }).toString();
}
const postReturn = (form) => fetch(`${base}/payments/hdfc/return`, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
});
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const webhook = (hdfcOrderId, auth = basic("hookuser", "hookpass"), event = "ORDER_SUCCEEDED") =>
  post("/api/webhooks/hdfc", { id: "evt_1", event_name: event, content: { order: { order_id: hdfcOrderId, status: "CHARGED" } } },
    auth ? { Authorization: auth } : {});
const charged = (id, over = {}) => ({ order_id: id, status: "CHARGED", status_id: 21, amount: 849, effective_amount: 849,
  currency: "INR", merchant_id: "TESTMID", payment_method_type: "UPI", txn_id: `TXN-${id}`, ...over });

async function started(opts) {
  const order = localOrder(opts);
  const res = await initiate(order.id);
  assert.equal(res.status, 200);
  return { order, hdfcId: order.hdfcAttempts.at(-1).hdfcOrderId, body: await res.json() };
}

// ── availability / flag / config ────────────────────────────────────────────
test("availability reports enabled only with flag + full config", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/payment/hdfc/availability`)).json(), { enabled: true });
  process.env.HDFC_SMARTGATEWAY_ENABLED = "false";
  assert.deepEqual(await (await fetch(`${base}/api/payment/hdfc/availability`)).json(), { enabled: false });
  process.env.HDFC_SMARTGATEWAY_ENABLED = "true";
  process.env.HDFC_SMARTGATEWAY_API_KEY = "";
  assert.deepEqual(await (await fetch(`${base}/api/payment/hdfc/availability`)).json(), { enabled: false });
});

test("initiate rejected server-side when the flag is off", async () => {
  process.env.HDFC_SMARTGATEWAY_ENABLED = "false";
  const res = await initiate(localOrder().id);
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

for (const [name, value] of [
  ["HDFC_SMARTGATEWAY_MERCHANT_ID", ""], ["HDFC_SMARTGATEWAY_PAYMENT_PAGE_CLIENT_ID", ""],
  ["HDFC_SMARTGATEWAY_API_KEY", ""], ["HDFC_SMARTGATEWAY_RESPONSE_KEY", ""],
  ["HDFC_SMARTGATEWAY_RETURN_URL", "https://firvanra.online/r?x=1"],
  ["HDFC_SMARTGATEWAY_BASE_URL", "https://smartgateway.hdfcuat.bank.in"], // prod env, UAT host
  ["HDFC_SMARTGATEWAY_ENV", "staging"], ["HDFC_SMARTGATEWAY_UPI_ONLY", "false"],
]) {
  test(`initiate 503 when ${name} is invalid/missing; no secret in response`, async () => {
    process.env[name] = value;
    const res = await initiate(localOrder().id);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(!text.includes("HDFC_SMARTGATEWAY"), "variable names not exposed");
    assert.equal(calls.length, 0);
  });
}

// ── session ─────────────────────────────────────────────────────────────────
test("session: backend amount, UPI-only filter, Basic auth, documented headers", async () => {
  const { order, body } = await started({ total: 849 });
  assert.deepEqual(body, { provider: "hdfc", type: "redirect",
    checkoutUrl: "https://smartgateway.hdfc.bank.in/orders/ordeh_x/payment-page" });
  const s = calls.find((c) => c.url.endsWith("/session"));
  assert.equal(s.body.amount, "849.00");
  assert.equal(s.body.currency, "INR");
  assert.equal(s.body.action, "paymentPage");
  assert.equal(s.body.payment_page_client_id, "TESTMID");
  assert.equal(s.body.return_url, CFG.HDFC_SMARTGATEWAY_RETURN_URL);
  assert.equal(s.body.customer_phone, "9000000000");
  assert.match(s.body.order_id, /^[A-Za-z0-9]{1,20}$/);
  assert.deepEqual(s.body.payment_filter, { allowDefaultOptions: false, options: [{ paymentMethodType: "UPI", enable: true }] });
  assert.deepEqual(s.body.payment_filter, UPI_ONLY_PAYMENT_FILTER);
  assert.equal(s.headers.Authorization, "Basic " + Buffer.from("fake-api-key").toString("base64"));
  assert.equal(s.headers["x-merchantid"], "TESTMID");
  assert.equal(s.headers["x-resellerid"], "hdfc_reseller");
  assert.ok(s.headers["x-customerid"] && !s.headers["x-customerid"].includes("@"));
  assert.equal(order.status, "pending");
  assert.equal(order.gateway, "hdfc");
  const exposed = JSON.stringify(await getOrder(order.id));
  assert.ok(!exposed.includes("fake-api-key") && !exposed.includes("fake-response-key"));
});

test("session: client-supplied amount is ignored", async () => {
  const order = localOrder({ total: 129 });
  await initiate(order.id, { amount: "1.00", total: 1 });
  assert.equal(calls.find((c) => c.url.endsWith("/session")).body.amount, "129.00");
});

test("session: invalid phone 400; HDFC error 502; foreign payment link refused", async () => {
  assert.equal((await initiate(localOrder({ phone: "123" }).id)).status, 400);
  sessionBehaviour = () => { const e = new Error("x"); e.response = { status: 401, data: {} }; throw e; };
  assert.equal((await initiate(localOrder().id)).status, 502);
  sessionBehaviour = (b) => ({ data: { order_id: b.order_id, payment_links: { web: "https://evil.example/pay" } } });
  assert.equal((await initiate(localOrder().id)).status, 502);
});

test("initiate: unknown order 404, paid order 409", async () => {
  assert.equal((await initiate("FIR-nope")).status, 404);
  const o = localOrder(); o.status = "paid";
  assert.equal((await initiate(o.id)).status, 409);
});

// ── return URL ──────────────────────────────────────────────────────────────
test("signature: kit algorithm accepted; tampered/missing/wrong key rejected", () => {
  const p = { order_id: "FIRabc", status: "CHARGED", status_id: "21" };
  const sig = sign(p);
  assert.ok(verifyReturnSignature({ ...p, signature: sig, signature_algorithm: "HMAC-SHA256" }, "fake-response-key"));
  assert.ok(verifyReturnSignature({ ...p, signature: encodeURIComponent(sig) }, "fake-response-key"));
  assert.ok(!verifyReturnSignature({ ...p, status: "FAILED", signature: sig }, "fake-response-key"));
  assert.ok(!verifyReturnSignature(p, "fake-response-key"));
  assert.ok(!verifyReturnSignature({ ...p, signature: sig }, "other-key"));
  assert.ok(!verifyReturnSignature({ ...p, signature: sig, signature_algorithm: "MD5" }, "fake-response-key"));
  // Juspay doc form: each key/value percent-encoded before joining.
  const q = { ...p, udf1: "a b&c=d" };
  const docStr = Object.keys(q).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`).join("&");
  const docSig = crypto.createHmac("sha256", "fake-response-key").update(encodeURIComponent(docStr)).digest("base64");
  assert.ok(verifyReturnSignature({ ...q, signature: docSig }, "fake-response-key"));
  assert.ok(!verifyReturnSignature({ ...q, udf1: "a b&c=e", signature: docSig }, "fake-response-key"));
});

test("valid return + Order Status CHARGED -> paid, redirected to order page", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  const res = await postReturn(returnForm(hdfcId));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"),
    `https://firvanra.online/order/${order.id}?status=pending&gateway=hdfc&returnStatus=success`);
  assert.equal(order.status, "paid");
  assert.equal(order.paidAmount, "849.00");
});

test("signed return claiming CHARGED does not pay when Order Status says pending", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, { ...charged(hdfcId), status: "PENDING_VBV", status_id: 23 });
  const res = await postReturn(returnForm(hdfcId));
  assert.equal(res.status, 303);
  assert.ok(!res.headers.get("location").includes("returnStatus"));
  assert.equal(order.status, "pending");
});

test("tampered or unsigned return changes nothing and does not query HDFC", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  calls.length = 0;
  const forged = returnForm(hdfcId, "CHARGED", "21", "attacker-key");
  assert.equal((await postReturn(forged)).status, 400);
  assert.equal((await postReturn(`order_id=${hdfcId}&status=CHARGED&status_id=21`)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(order.status, "pending");
});

test("Order Status amount / currency / order_id mismatch never pays", async () => {
  for (const over of [{ amount: 1 }, { effective_amount: 1 }, { currency: "USD" }, { merchant_id: "OTHER" }]) {
    const { order, hdfcId } = await started();
    book.set(hdfcId, charged(hdfcId, over));
    await postReturn(returnForm(hdfcId));
    assert.equal(order.status, "pending", JSON.stringify(over));
  }
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged("someoneelse"));
  await postReturn(returnForm(hdfcId));
  assert.equal(order.status, "pending");
});

test("failed and cancelled/abandoned outcomes", async () => {
  for (const [status, expected] of [["AUTHORIZATION_FAILED", "failed"], ["AUTHENTICATION_FAILED", "failed"],
    ["JUSPAY_DECLINED", "failed"], ["NEW", "pending"], ["AUTHORIZING", "pending"]]) {
    const { order, hdfcId } = await started();
    book.set(hdfcId, { ...charged(hdfcId), status });
    await postReturn(returnForm(hdfcId, status));
    assert.equal(order.status, expected, status);
  }
  assert.equal(classifyHdfcStatus("AUTHORIZED"), "unknown");
});

test("Order Status unavailable on return: stays pending", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, () => { const e = new Error("t"); e.code = "ECONNABORTED"; throw e; });
  const res = await postReturn(returnForm(hdfcId));
  assert.equal(res.status, 303);
  assert.equal(order.status, "pending");
});

// ── webhook ─────────────────────────────────────────────────────────────────
test("webhook: auth required, then Order Status decides", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  assert.equal((await webhook(hdfcId, null)).status, 401);
  assert.equal((await webhook(hdfcId, basic("hookuser", "wrong"))).status, 401);
  assert.equal(order.status, "pending");
  const res = await webhook(hdfcId);
  assert.equal(res.status, 200);
  assert.equal(order.status, "paid");
});

test("webhook claiming success is ignored when Order Status says failed", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, { ...charged(hdfcId), status: "AUTHORIZATION_FAILED" });
  assert.equal((await webhook(hdfcId)).status, 200);
  assert.equal(order.status, "failed");
});

test("webhook fails closed without webhook credentials; 503 when status unavailable; 404 unknown", async () => {
  const { hdfcId } = await started();
  process.env.HDFC_SMARTGATEWAY_WEBHOOK_PASSWORD = "";
  assert.equal((await webhook(hdfcId)).status, 503);
  process.env.HDFC_SMARTGATEWAY_WEBHOOK_PASSWORD = "hookpass";
  book.set(hdfcId, () => { throw new Error("net"); });
  assert.equal((await webhook(hdfcId)).status, 503);
  assert.equal((await webhook("FIRunknown")).status, 404);
});

test("duplicate notifications are idempotent; paidAt never moves", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  await webhook(hdfcId);
  const paidAt = order.paidAt;
  await webhook(hdfcId);
  await postReturn(returnForm(hdfcId));
  assert.equal(order.status, "paid");
  assert.equal(order.paidAt, paidAt);
});

test("late failure never downgrades a verified payment", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  await webhook(hdfcId);
  book.set(hdfcId, { ...charged(hdfcId), status: "AUTHORIZATION_FAILED" });
  await webhook(hdfcId, undefined, "ORDER_FAILED");
  assert.equal(order.status, "paid");
});

test("late payment still settles after checkout initiation is disabled", async () => {
  const { order, hdfcId } = await started();
  process.env.HDFC_SMARTGATEWAY_ENABLED = "false";
  book.set(hdfcId, charged(hdfcId));
  assert.equal((await webhook(hdfcId)).status, 200);
  assert.equal(order.status, "paid");
});

test("non-UPI CHARGED is settled but flagged", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId, { payment_method_type: "CARD" }));
  await webhook(hdfcId);
  assert.equal(order.status, "paid");
  assert.equal(order.hdfcAttempts[0].nonUpiPayment, true);
});

// ── delayed results / retries ───────────────────────────────────────────────
test("order page poll reconciles a pending HDFC order (delayed notification)", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  const polled = await getOrder(order.id);
  assert.equal(polled.status, "paid");
});

test("retry: new attempt after failure; blocked while previous is in flight; paid blocks", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, { ...charged(hdfcId), status: "AUTHORIZING" });
  assert.equal((await initiate(order.id)).status, 409);
  book.set(hdfcId, { ...charged(hdfcId), status: "AUTHORIZATION_FAILED" });
  assert.equal((await initiate(order.id)).status, 200);
  assert.equal(order.hdfcAttempts.length, 2);
  const second = order.hdfcAttempts[1].hdfcOrderId;
  assert.notEqual(second, hdfcId);
  // A late result for the OLD attempt does not reopen/fail the new one.
  await webhook(hdfcId);
  assert.equal(order.status, "pending");
  book.set(second, charged(second));
  await webhook(second);
  assert.equal(order.status, "paid");
  assert.equal((await initiate(order.id)).status, 409);
});

test("retry: previous attempt found CHARGED on retry settles instead of charging twice", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, charged(hdfcId));
  const res = await initiate(order.id);
  assert.equal(res.status, 409);
  assert.equal(order.status, "paid");
  assert.equal(order.hdfcAttempts.length, 1);
});

test("second CHARGED attempt on a paid order is flagged, not re-fulfilled", async () => {
  const { order, hdfcId } = await started();
  book.set(hdfcId, { ...charged(hdfcId), status: "AUTHORIZATION_FAILED" });
  await initiate(order.id);
  const second = order.hdfcAttempts[1].hdfcOrderId;
  book.set(second, charged(second));
  await webhook(second);
  const paidAt = order.paidAt;
  book.set(hdfcId, charged(hdfcId)); // first attempt later also captured
  await webhook(hdfcId);
  assert.equal(order.paidAt, paidAt);
  assert.equal(order.hdfcPaidOrderId, second);
  assert.equal(order.hdfcAttempts[0].duplicateCharge, true);
});

// ── existing gateways untouched ─────────────────────────────────────────────
test("existing gateway routes still respond", async () => {
  assert.equal((await post("/api/payment/payu/initiate", {})).status, 400);
  assert.equal((await post("/api/payment/sabpaisa/initiate", {})).status, 400);
  assert.equal((await post("/api/payment/airpay-2/initiate", {})).status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
