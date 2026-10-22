// AirPay 2 (second merchant): initiate, callback/IPN, Verify API authority and
// KKChat forwarding. Runs against the real server.js so route registration
// order (raw parser before the global body parsers) is covered too.
//
// Nothing external is contacted: axios (AirPay OAuth + Verify) is mocked and
// global fetch is stubbed for the KKChat URL only. Fake credentials only.
//
// Run: node --test routes/payment.airpay2.test.js

import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import CRC32 from "crc-32";

// Merchant 1 and merchant 2 get DIFFERENT fake credentials so any mix-up shows.
const M1 = {
  AIRPAY_MERCHANT_ID: "111111", AIRPAY_USERNAME: "m1user", AIRPAY_PASSWORD: "m1pass",
  AIRPAY_SECRET: "m1secret", AIRPAY_CLIENT_ID: "m1client", AIRPAY_CLIENT_SECRET: "m1clientsecret",
};
const M2 = {
  AIRPAY_MID_2: "222222", AIRPAY_USERNAME_2: "m2user", AIRPAY_PASSWORD_2: "m2pass",
  AIRPAY_API_KEY_2: "m2apikey", AIRPAY_CLIENT_ID_2: "m2client", AIRPAY_CLIENT_SECRET_2: "m2clientsecret",
};
Object.assign(process.env, M1, M2, { VERCEL: "1", FRONTEND_URL: "https://firvanra.online" });
for (const k of ["AIRPAY_ENCRYPTION_KEY_2", "AIRPAY_OAUTH_URL_2", "AIRPAY_PAY_URL_2", "AIRPAY_VERIFY_URL_2"])
  delete process.env[k];

const axios = (await import("axios")).default;
const app = (await import("../server.js")).default;
const { orders } = await import("./orders.js");
const { airpay2Config, _internals } = await import("../services/airpay2.js");
const { forwardAirpay2Callback, KKCHAT_AIRPAY2_CALLBACK_URL, _resetForwarderState } =
  await import("../services/kkchatForwarder.js");

const CALLBACK_PATH = "/callback/cpm/arp_firvanra/collection";
const KKCHAT = "https://kkchat.in/callback/cpm/arp_firvanra/collection";
const OAUTH_URL = "https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/";
const VERIFY_URL = "https://kraken.airpay.co.in/airpay/pay/v4/api/verify/";
const PAY_URL = "https://payments.airpay.co.in/pay/v4/";

const cfg2 = () => airpay2Config();
const decryptForm = (formBody) => {
  const p = new URLSearchParams(formBody);
  return { form: Object.fromEntries(p), data: JSON.parse(_internals.decrypt(cfg2(), p.get("encdata"))) };
};

// ── AirPay mock (axios) ─────────────────────────────────────────────────────
// verifyBook: ap_transactionid -> AirPay's record (the `data` object), or a
// function returning a full axios response / throwing.
const airpayCalls = [];
const verifyBook = new Map();
let oauthBehaviour = null;

mock.method(axios, "post", async (url, body) => {
  airpayCalls.push({ url, body });
  // Any OAuth URL: merchant 1's comes from its own (possibly real) env value.
  if (/\/oauth2\/?$/.test(url)) {
    if (oauthBehaviour) return oauthBehaviour();
    return { data: { data: { access_token: "tok-m2" } } };
  }
  if (url.startsWith(VERIFY_URL)) {
    const { data } = decryptForm(body);
    const entry = verifyBook.get(data.ap_transactionid);
    if (typeof entry === "function") return entry(data);
    if (!entry) return { data: { status_code: "200", status: "success", data: { transaction_status: 503 } } };
    return { data: { status_code: "200", status: "success", response_code: "00", message: "Success", data: entry } };
  }
  throw new Error(`unexpected axios.post ${url}`);
});

// ── KKChat stub (fetch) ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const kk = { calls: [], respond: () => new Response("OK", { status: 200 }) };
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith("https://kkchat.in")) {
    kk.calls.push({
      url: String(url), method: init.method,
      contentType: init.headers?.["Content-Type"],
      body: Buffer.from(init.body).toString("utf8"),
    });
    return kk.respond(init);
  }
  return realFetch(url, init);
};

let server, base;
before(async () => {
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  airpayCalls.length = 0;
  kk.calls.length = 0;
  kk.respond = () => new Response("OK", { status: 200 });
  oauthBehaviour = null;
  _resetForwarderState();
  Object.assign(process.env, M1, M2);
});

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
const uid = () => `${Date.now().toString(36)}${++seq}`;

function localOrder({ total = 849, status = "pending", airpay2 = true } = {}) {
  const id = `FIR-a2${uid()}`;
  const order = {
    id, total, items: [{ id: "p1", title: "T", price: total, qty: 1 }],
    buyer: { firstName: "Asha Rao", email: "a@b.c", phone: "9000000000" },
    status, createdAt: new Date().toISOString(),
  };
  if (airpay2) Object.assign(order, { gateway: "airpay_2", airpay2OrderId: id });
  orders.set(id, order);
  return order;
}

const crc = (parts) => (CRC32.str(parts.join(":")) >>> 0).toString();

function callback({
  orderid, ap_transactionid = `AP${uid()}`, amount = "849.00",
  transaction_status = "200", transaction_payment_status = "SUCCESS", message = "Success",
  mid = M2.AIRPAY_MID_2, username = M2.AIRPAY_USERNAME_2, merchant_id = M2.AIRPAY_MID_2,
  ...extra
} = {}) {
  return {
    merchant_id, orderid, ap_transactionid, amount, transaction_status,
    transaction_payment_status, message, chmod: "pg", currency_code: "356",
    ap_SecureHash: crc([orderid, ap_transactionid, amount, transaction_status, message, mid, username]),
    ...extra,
  };
}

// AirPay's record agrees with the callback unless overridden.
const recordFor = (cb, over = {}) => {
  const { ap_SecureHash, ...rest } = cb;
  return { ...rest, ...over };
};

// Browser return: a top-level form navigation, with the headers browsers send.
const BROWSER_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Sec-Fetch-Mode": "navigate",
};
const postForm = (obj) => {
  const body = new URLSearchParams(obj).toString();
  return fetch(`${base}${CALLBACK_PATH}`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...BROWSER_HEADERS }, body,
  }).then((res) => ({ res, body }));
};
// Form-encoded server-to-server IPN: same body format, no browser markers.
const postServerForm = (obj) => {
  const body = new URLSearchParams(obj).toString();
  return fetch(`${base}${CALLBACK_PATH}`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" }, body,
  }).then((res) => ({ res, body }));
};
const postJson = (obj, raw) => {
  const body = raw ?? JSON.stringify(obj);
  return fetch(`${base}${CALLBACK_PATH}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }).then((res) => ({ res, body }));
};
const initiate = (body) => fetch(`${base}/api/payment/airpay-2/initiate`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const verifyCalls = () => airpayCalls.filter((c) => c.url.startsWith(VERIFY_URL));

// ═════════════════════════════ Initiation ══════════════════════════════════

test("initiate uses ONLY the AirPay 2 credentials", async () => {
  const order = localOrder({ airpay2: false });
  const res = await initiate({ orderId: order.id });
  assert.equal(res.status, 200);
  const body = await res.json();

  const oauth = airpayCalls.find((c) => c.url === OAUTH_URL);
  const { form, data } = decryptForm(oauth.body);
  assert.equal(form.merchant_id, M2.AIRPAY_MID_2);
  assert.equal(data.client_id, M2.AIRPAY_CLIENT_ID_2);
  assert.equal(data.client_secret, M2.AIRPAY_CLIENT_SECRET_2);
  assert.equal(data.merchant_id, M2.AIRPAY_MID_2);

  const expectedPk = crypto.createHash("sha256")
    .update(`${M2.AIRPAY_API_KEY_2}@${M2.AIRPAY_USERNAME_2}:|:${M2.AIRPAY_PASSWORD_2}`).digest("hex");
  const merchant1Pk = crypto.createHash("sha256")
    .update(`${M1.AIRPAY_SECRET}@${M1.AIRPAY_USERNAME}:|:${M1.AIRPAY_PASSWORD}`).digest("hex");
  assert.equal(body.fields.privatekey, expectedPk);
  assert.notEqual(body.fields.privatekey, merchant1Pk);
  assert.equal(body.fields.merchant_id, M2.AIRPAY_MID_2);
  assert.ok(!JSON.stringify(body).includes(M1.AIRPAY_MERCHANT_ID), "no merchant-1 id anywhere");
});

test("initiate returns the existing form contract with AirPay v4 field names", async () => {
  const order = localOrder({ airpay2: false });
  const body = await (await initiate({ orderId: order.id })).json();
  assert.equal(body.type, "form");
  assert.equal(body.gateway, "airpay_2");
  assert.equal(body.method, "POST");
  assert.equal(body.action, `${PAY_URL}?token=tok-m2`);
  assert.deepEqual(Object.keys(body.fields).sort(), ["checksum", "encdata", "merchant_id", "privatekey"]);
  assert.match(body.fields.checksum, /^[0-9a-f]{64}$/);
});

test("initiate derives the amount from the server-side order, ignoring the request", async () => {
  const order = localOrder({ total: 849, airpay2: false });
  const body = await (await initiate({ orderId: order.id, amount: 1, total: 1 })).json();
  const data = JSON.parse(_internals.decrypt(cfg2(), body.fields.encdata));
  assert.equal(data.amount, "849.00");
  assert.equal(data.orderid, order.id);
  assert.equal(data.currency_code, "356");
  assert.equal(data.iso_currency, "INR");
  assert.equal(data.buyer_firstname, "Asha");
  assert.equal(data.buyer_lastname, "Rao");
});

test("initiate records attempt metadata on the order, never secrets", async () => {
  const order = localOrder({ airpay2: false });
  await initiate({ orderId: order.id });
  const stored = orders.get(order.id);
  assert.equal(stored.gateway, "airpay_2");
  assert.equal(stored.airpay2OrderId, order.id);
  assert.equal(stored.airpay2Amount, "849.00");
  assert.equal(stored.status, "pending");
  const publicView = JSON.stringify(await (await fetch(`${base}/api/orders/${order.id}`)).json());
  for (const s of ["privatekey", "checksum", "encdata", "tok-m2", ...Object.values(M2).slice(1)])
    assert.ok(!publicView.includes(s), `order must not expose ${s}`);
});

test("initiate with a missing AirPay 2 credential is a 503 and never uses merchant 1", async () => {
  for (const name of Object.keys(M2)) {
    Object.assign(process.env, M2);
    delete process.env[name];
    airpayCalls.length = 0;
    const order = localOrder({ airpay2: false });
    const res = await initiate({ orderId: order.id });
    assert.equal(res.status, 503, `${name} missing must be 503`);
    const text = await res.text();
    assert.ok(!/simulated|fields|privatekey|AIRPAY_/i.test(text), "no simulation, no names/secrets");
    assert.equal(airpayCalls.length, 0, "no gateway call with partial credentials");
    assert.equal(orders.get(order.id).gateway, undefined);
  }
});

test("initiate rejects missing, unknown and already-paid orders", async () => {
  assert.equal((await initiate({})).status, 400);
  assert.equal((await initiate({ orderId: 42 })).status, 400);
  assert.equal((await initiate({ orderId: "FIR-nope" })).status, 404);
  const paid = localOrder({ status: "paid" });
  assert.equal((await initiate({ orderId: paid.id })).status, 409);
  const bad = localOrder({ total: 0 });
  assert.equal((await initiate({ orderId: bad.id })).status, 400);
  assert.equal(airpayCalls.length, 0);
});

test("initiate maps an OAuth failure to 502 without leaking details", async () => {
  oauthBehaviour = () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ECONNABORTED" }); };
  const order = localOrder({ airpay2: false });
  const res = await initiate({ orderId: order.id });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Could not reach AirPay 2." });
});

test("the original AirPay initiate route is still separate", async () => {
  // Merchant-1 is configured with fake values here; its route must still call
  // its own OAuth with ITS merchant id, never merchant 2's.
  const order = localOrder({ airpay2: false });
  await fetch(`${base}/api/payment/airpay/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });
  assert.ok(airpayCalls.length > 0, "merchant 1 OAuth was exercised");
  for (const c of airpayCalls) {
    assert.ok(String(c.body).includes(`merchant_id=${M1.AIRPAY_MERCHANT_ID}`), "merchant 1 route sends MID 1");
    assert.ok(!String(c.body).includes(`merchant_id=${M2.AIRPAY_MID_2}`), "merchant 1 route never sends MID 2");
  }
  assert.equal(orders.get(order.id).gateway, undefined, "original route does not tag airpay_2");
});

// ═════════════════════════════ Callback / IPN ══════════════════════════════

test("callback route is registered at the exact URL; GET does not touch state", async () => {
  const get = await fetch(`${base}${CALLBACK_PATH}`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const post = await postJson({});
  assert.notEqual(post.res.status, 404);
});

test("browser return (form) success: verified, local order paid, forwarded verbatim", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));

  const { res, body } = await postForm(cb);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"),
    `https://firvanra.online/order/${order.id}?status=pending&gateway=airpay_2&returnStatus=success`);
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(orders.get(order.id).airpay2TransactionId, cb.ap_transactionid);

  assert.equal(kk.calls.length, 1);
  assert.equal(kk.calls[0].url, KKCHAT);
  assert.equal(kk.calls[0].method, "POST");
  assert.equal(kk.calls[0].contentType, "application/x-www-form-urlencoded");
  assert.equal(kk.calls[0].body, body, "raw body forwarded byte-for-byte");
});

test("IPN (JSON) success: 200 ack, forwarded with original JSON bytes and content type", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  // Deliberately odd formatting: re-serialising would change these bytes.
  const raw = JSON.stringify(cb, null, 1).replace(/\n/g, "\r\n");

  const { res } = await postJson(null, raw);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, forwarded: true, duplicate: false });
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(kk.calls[0].body, raw);
  assert.equal(kk.calls[0].contentType, "application/json");
});

test("server-side verify is called with the merchant-2 credentials and references", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  await postJson(cb);

  const [call] = verifyCalls();
  assert.equal(call.url, `${VERIFY_URL}?token=tok-m2`);
  const { form, data } = decryptForm(call.body);
  assert.equal(form.merchant_id, M2.AIRPAY_MID_2);
  assert.ok(form.privatekey && form.checksum);
  assert.deepEqual(data, { orderid: order.id, ap_transactionid: cb.ap_transactionid });
});

test("an encrypted Verify API response is decrypted and honoured", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, () => ({
    data: { response: _internals.encrypt(cfg2(), JSON.stringify({
      status_code: "200", status: "success", data: recordFor(cb),
    })) },
  }));
  const { res } = await postJson(cb);
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "paid");
});

test("failed payment: order failed (verified), authentic failure forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id, transaction_status: "400",
    transaction_payment_status: "FAILED", message: "Failed" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res } = await postJson(cb);
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "failed");
  assert.equal(orders.get(order.id).paidAt, undefined);
  assert.equal(kk.calls.length, 1);
});

test("pending payment: order stays pending, forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id, transaction_status: "211",
    transaction_payment_status: "TRANSACTION IN PROCESS", message: "Processing" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res } = await postJson(cb);
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 1);
});

test("unknown local order: verified callback is forwarded, no order is created", async () => {
  const cb = callback({ orderid: "KKC-EXT-987654" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const before = orders.size;

  const ipn = await postJson(cb);
  assert.equal(ipn.res.status, 200);
  assert.equal(orders.size, before, "no fake Firvanra order");
  assert.equal(orders.has("KKC-EXT-987654"), false);
  assert.equal(kk.calls.length, 1);
  assert.equal(kk.calls[0].body, ipn.body);

  // Browser return for an external order: a neutral page, not a KKChat redirect.
  const cb2 = callback({ orderid: "KKC-EXT-111" });
  verifyBook.set(cb2.ap_transactionid, recordFor(cb2));
  const browser = await postForm(cb2);
  assert.equal(browser.res.status, 200);
  assert.equal(browser.res.headers.get("location"), null);
  assert.match(await browser.res.text(), /Payment response received/);
});

test("a matching order started by another gateway is never modified", async () => {
  const order = localOrder({ airpay2: false }); // e.g. an original-AirPay order
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  await postJson(cb);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 1, "authentic merchant-2 event is still relayed");
});

test("invalid hash: rejected before verify, never forwarded", async () => {
  const order = localOrder();
  const cb = { ...callback({ orderid: order.id }), ap_SecureHash: "123" };
  const { res } = await postJson(cb);
  assert.equal(res.status, 400);
  assert.equal(verifyCalls().length, 0);
  assert.equal(kk.calls.length, 0);
  assert.equal(orders.get(order.id).status, "pending");
});

test("tampered amount (hash no longer matches) is rejected", async () => {
  const order = localOrder();
  const cb = { ...callback({ orderid: order.id, amount: "849.00" }), amount: "1.00" };
  assert.equal((await postForm(cb)).res.status, 400);
  assert.equal(kk.calls.length, 0);
});

test("wrong merchant: a different merchant_id or a merchant-1-signed callback is rejected", async () => {
  const order = localOrder();
  const wrongMid = callback({ orderid: order.id, merchant_id: M1.AIRPAY_MERCHANT_ID });
  assert.equal((await postJson(wrongMid)).res.status, 400);
  const m1Signed = callback({ orderid: order.id, merchant_id: M1.AIRPAY_MERCHANT_ID,
    mid: M1.AIRPAY_MERCHANT_ID, username: M1.AIRPAY_USERNAME });
  assert.equal((await postJson(m1Signed)).res.status, 400);
  assert.equal(verifyCalls().length, 0);
  assert.equal(kk.calls.length, 0);
});

test("malformed and incomplete payloads are rejected and never forwarded", async () => {
  assert.equal((await postJson(null, "{not json")).res.status, 400);
  assert.equal((await postJson(null, "[1,2]")).res.status, 400);
  assert.equal((await postJson(null, "")).res.status, 400);
  const { ap_SecureHash, ...noHash } = callback({ orderid: "FIR-x" });
  assert.equal((await postJson(noHash)).res.status, 400);
  const { orderid, ...noOrder } = callback({ orderid: "FIR-x" });
  assert.equal((await postForm(noOrder)).res.status, 400);
  assert.equal(kk.calls.length, 0);
});

test("UPI callbacks validate with the customer VPA appended to the hash input", async () => {
  const cb = callback({ orderid: "KKC-UPI-1" });
  cb.chmod = "upi";
  cb.customer_vpa = "asha@upi";
  cb.ap_SecureHash = crc([cb.orderid, cb.ap_transactionid, cb.amount, cb.transaction_status,
    cb.message, M2.AIRPAY_MID_2, M2.AIRPAY_USERNAME_2, cb.customer_vpa]);
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  assert.equal((await postJson(cb)).res.status, 200);
});

test("duplicate browser return + IPN: settled once, forwarded once", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));

  await postForm(cb);
  const paidAt = orders.get(order.id).paidAt;
  const second = await postJson(cb);
  assert.equal(second.res.status, 200);
  assert.equal((await second.res.json()).duplicate, true);
  const third = await postJson(cb); // repeated IPN
  assert.equal(third.res.status, 200);

  assert.equal(orders.get(order.id).paidAt, paidAt, "paidAt never moves");
  assert.equal(kk.calls.length, 1);
});

test("concurrent duplicate callbacks share one KKChat delivery", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => new Promise((r) => setTimeout(() => r(new Response("OK")), 50));
  const results = await Promise.all([postJson(cb), postJson(cb), postForm(cb)]);
  for (const { res } of results) assert.ok([200, 303].includes(res.status));
  assert.equal(kk.calls.length, 1);
});

test("out-of-order: a late failure callback cannot undo a verified payment", async () => {
  const order = localOrder();
  const apTxn = `AP${uid()}`;
  const success = callback({ orderid: order.id, ap_transactionid: apTxn });
  const lateFail = callback({ orderid: order.id, ap_transactionid: apTxn,
    transaction_status: "400", transaction_payment_status: "FAILED", message: "Failed" });
  verifyBook.set(apTxn, recordFor(success)); // AirPay's current record: success

  await postJson(success);
  const { res } = await postJson(lateFail);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, forwarded: false, reason: "superseded" });
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(kk.calls.length, 1, "stale failure not relayed");
});

test("out-of-order: pending arriving after success leaves the order paid", async () => {
  const order = localOrder();
  const apTxn = `AP${uid()}`;
  verifyBook.set(apTxn, recordFor(callback({ orderid: order.id, ap_transactionid: apTxn })));
  await postJson(callback({ orderid: order.id, ap_transactionid: apTxn }));
  await postJson(callback({ orderid: order.id, ap_transactionid: apTxn,
    transaction_status: "211", transaction_payment_status: "TRANSACTION IN PROCESS" }));
  assert.equal(orders.get(order.id).status, "paid");
});

test("already-paid protection: a different transaction's failure never regresses it", async () => {
  const order = localOrder();
  const first = callback({ orderid: order.id });
  verifyBook.set(first.ap_transactionid, recordFor(first));
  await postJson(first);

  const other = callback({ orderid: order.id, transaction_status: "400",
    transaction_payment_status: "FAILED", message: "Failed" });
  verifyBook.set(other.ap_transactionid, recordFor(other));
  await postJson(other);
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(orders.get(order.id).airpay2TransactionId, first.ap_transactionid);
});

test("callback claiming success that verify reports as pending: not paid, not forwarded, retry", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb, {
    transaction_status: "211", transaction_payment_status: "TRANSACTION IN PROCESS" }));
  const { res } = await postJson(cb);
  assert.equal(res.status, 503);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 0);
});

test("verify API unavailable or timing out: nothing settled or forwarded, IPN gets 503", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, () => {
    throw Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" });
  });
  const ipn = await postJson(cb);
  assert.equal(ipn.res.status, 503);
  const browser = await postForm(cb);
  assert.equal(browser.res.status, 503, "never acknowledged, whatever the headers");
  assert.equal(browser.res.headers.get("location"), null);
  const page = await browser.res.text();
  assert.match(page, /http-equiv="refresh" content="0;url=https:\/\/firvanra\.online\/order\//,
    "customer still lands on the order page");
  assert.match(page, /status=pending&amp;gateway=airpay_2"/);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 0);
});

test("verify API logical error or no record: nothing settled or forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, () => ({
    data: { status_code: "400", status: "fail", response_code: 501, message: "Invalid Merchant Id", data: [] },
  }));
  assert.equal((await postJson(cb)).res.status, 503);

  const unknownTxn = callback({ orderid: order.id }); // not in verifyBook -> 503 "no records"
  assert.equal((await postJson(unknownTxn)).res.status, 503);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 0);
});

test("verify record describing a different amount/txn is a mismatch: rejected", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb, { amount: "1.00" }));
  assert.equal((await postJson(cb)).res.status, 400);
  const cb2 = callback({ orderid: order.id });
  verifyBook.set(cb2.ap_transactionid, recordFor(cb2, { orderid: "FIR-someone-else" }));
  assert.equal((await postJson(cb2)).res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 0);
});

test("authentic payment for the wrong amount does not settle the local order", async () => {
  const order = localOrder({ total: 849 });
  const cb = callback({ orderid: order.id, amount: "1.00" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res } = await postJson(cb);
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "pending", "underpayment never marks paid");
  assert.equal(kk.calls.length, 1, "relay is independent of local settlement");
});

// ═════════════════════════════ KKChat forwarding ═══════════════════════════

test("KKChat HTTP 5xx: retried, then the IPN is not acknowledged; local state kept", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => new Response("down", { status: 503 });

  const { res } = await postJson(cb);
  assert.equal(res.status, 502);
  assert.equal(kk.calls.length, 2, "bounded in-request retry");
  assert.equal(orders.get(order.id).status, "paid", "settlement independent of relay");

  // AirPay re-sends: delivery now succeeds and is not treated as a duplicate.
  kk.respond = () => new Response("OK", { status: 200 });
  const retry = await postJson(cb);
  assert.equal(retry.res.status, 200);
  assert.equal((await retry.res.json()).duplicate, false);
  assert.equal(kk.calls.length, 3);
});

test("KKChat 4xx is not retried", async () => {
  const cb = callback({ orderid: "KKC-4xx" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => new Response("bad", { status: 400 });
  assert.equal((await postJson(cb)).res.status, 502);
  assert.equal(kk.calls.length, 1);
});

test("KKChat network error on a browser return: 502 page that still sends the customer on", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => { throw new TypeError("fetch failed"); };
  const { res } = await postForm(cb);
  assert.equal(res.status, 502, "relay failure is never acknowledged");
  assert.match(await res.text(), /http-equiv="refresh"[^>]*returnStatus=success/);
  assert.equal(orders.get(order.id).status, "paid");
});

test("forwarder: exact destination, POST, raw bytes, content type", async () => {
  assert.equal(KKCHAT_AIRPAY2_CALLBACK_URL, KKCHAT);
  const raw = Buffer.from("orderid=X&amount=1.00&ap_SecureHash=1");
  const r = await forwardAirpay2Callback({ rawBody: raw, contentType: "application/x-www-form-urlencoded; charset=UTF-8", dedupKey: "k1" });
  assert.equal(r.ok, true);
  assert.deepEqual(kk.calls[0], {
    url: KKCHAT, method: "POST",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    body: raw.toString(),
  });
});

test("forwarder: a timeout is reported, retried and bounded", async () => {
  kk.respond = (init) => new Promise((_r, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  const started = Date.now();
  const r = await forwardAirpay2Callback({ rawBody: "x", contentType: "application/json",
    dedupKey: "k-timeout", timeoutMs: 50, attempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout");
  assert.equal(r.attempts, 2);
  assert.ok(Date.now() - started < 2000);
});

test("forwarder: dedup only remembers successful deliveries", async () => {
  kk.respond = () => new Response("x", { status: 500 });
  await forwardAirpay2Callback({ rawBody: "x", contentType: "application/json", dedupKey: "k2", attempts: 1 });
  kk.respond = () => new Response("OK");
  const ok = await forwardAirpay2Callback({ rawBody: "x", contentType: "application/json", dedupKey: "k2", attempts: 1 });
  assert.equal(ok.duplicate, undefined);
  const dup = await forwardAirpay2Callback({ rawBody: "x", contentType: "application/json", dedupKey: "k2", attempts: 1 });
  assert.equal(dup.duplicate, true);
  assert.equal(kk.calls.length, 2);
});

test("the destination cannot be steered by the request", async () => {
  const cb = callback({ orderid: "KKC-steer", url: "https://evil.example/x", destination: "https://evil.example" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const res = await fetch(`${base}${CALLBACK_PATH}?url=https://evil.example`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forward-To": "https://evil.example" },
    body: JSON.stringify(cb),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(kk.calls.map((c) => c.url), [KKCHAT]);
});

// ═════════════════════════════ Isolation ═══════════════════════════════════

test("the existing callback routes are untouched", async () => {
  const sapa = await fetch(`${base}/callback/cpm/sapa/collection`, { method: "POST" });
  assert.equal(sapa.status, 410);
  const ap1 = await fetch(`${base}/api/payment/airpay/callback`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "orderid=FIR-none&transaction_status=200",
  });
  assert.ok(ap1.status >= 300 && ap1.status < 400, "original AirPay callback still redirects");
  assert.equal(kk.calls.length, 0);
});

test("global body parsing for other routes still works after the raw route", async () => {
  const res = await fetch(`${base}/api/orders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Cart is empty." });
});

// ═════════════════════════════ Channel detection ═══════════════════════════

const { callbackChannel } = await import("./airpay2.js");

test("channel: JSON is IPN; form is browser only with navigation markers, else ambiguous", () => {
  assert.equal(callbackChannel({ "content-type": "application/json" }), "ipn");
  assert.equal(callbackChannel({ "content-type": "application/json; charset=utf-8", accept: "text/html" }), "ipn");
  assert.equal(callbackChannel({ "content-type": "application/x-www-form-urlencoded",
    accept: "text/html,application/xhtml+xml" }), "browser");
  assert.equal(callbackChannel({ "content-type": "application/x-www-form-urlencoded",
    "sec-fetch-mode": "navigate" }), "browser");
  assert.equal(callbackChannel({ "content-type": "application/x-www-form-urlencoded", accept: "*/*" }), "ambiguous");
  assert.equal(callbackChannel({ "content-type": "application/x-www-form-urlencoded" }), "ambiguous");
  assert.equal(callbackChannel({}), "ambiguous");
});

test("form-encoded IPN success: JSON 200 ack (not a redirect), settled, forwarded verbatim", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res, body } = await postServerForm(cb);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.deepEqual(await res.json(), { received: true, forwarded: true, duplicate: false });
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(kk.calls.length, 1);
  assert.equal(kk.calls[0].contentType, "application/x-www-form-urlencoded");
  assert.equal(kk.calls[0].body, body);
});

test("form-encoded IPN failure: order failed, authentic failure forwarded, 200 ack", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id, transaction_status: "400",
    transaction_payment_status: "FAIL", message: "Failed" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res } = await postServerForm(cb);
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "failed");
  assert.equal(kk.calls.length, 1);
});

test("form-encoded IPN keeps its re-send signals: 503 when unverifiable, 502 when relay fails", async () => {
  const cb = callback({ orderid: "66862257128204165" });
  verifyBook.set(cb.ap_transactionid, () => { const e = new Error("t"); e.code = "ECONNABORTED"; throw e; });
  const unverifiable = await postServerForm(cb);
  assert.equal(unverifiable.res.status, 503, "previously swallowed as a 200 browser page");
  assert.equal(kk.calls.length, 0);

  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => new Response("down", { status: 500 });
  const relayFailed = await postServerForm(cb);
  assert.equal(relayFailed.res.status, 502);

  kk.respond = () => new Response("OK", { status: 200 });
  const resent = await postServerForm(cb);
  assert.equal(resent.res.status, 200);
  assert.equal((await resent.res.json()).forwarded, true);
});

test("browser return failure: redirected with returnStatus=failure, failure forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id, transaction_status: "400",
    transaction_payment_status: "FAIL", message: "Cancelled by user" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res } = await postForm(cb);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /returnStatus=failure$/);
  assert.equal(orders.get(order.id).status, "failed");
  assert.equal(kk.calls.length, 1);
});

test("browser return with missing fields: error page, nothing verified or forwarded", async () => {
  const { res } = await postForm({ orderid: "FIR-x", transaction_status: "200" });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(verifyCalls().length, 0);
  assert.equal(kk.calls.length, 0);
});

test("IPN first, then browser return: settled once, forwarded once, customer redirected", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const ipn = await postServerForm(cb);
  assert.equal(ipn.res.status, 200);
  const paidAt = orders.get(order.id).paidAt;
  const browser = await postForm(cb);
  assert.equal(browser.res.status, 303);
  assert.match(browser.res.headers.get("location"), /returnStatus=success$/);
  assert.equal(orders.get(order.id).paidAt, paidAt);
  assert.equal(kk.calls.length, 1);
});

test("delayed IPN after a verified browser return is acknowledged as a duplicate", async () => {
  const cb = callback({ orderid: "66862257128204166" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  assert.equal((await postForm(cb)).res.status, 200, "unknown local order: neutral page");
  await new Promise((r) => setTimeout(r, 20));
  const late = await postJson(cb);
  assert.equal(late.res.status, 200);
  assert.equal((await late.res.json()).duplicate, true);
  assert.equal(kk.calls.length, 1);
});

test("verify record in a different currency is a mismatch: rejected, not forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb, { currency_code: "840" }));
  assert.equal((await postJson(cb)).res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 0);
});

// ── Status never depends on headers ─────────────────────────────────────────
// AirPay's IPN request headers are unconfirmed. A form IPN that happens to send
// browser-like headers must still get its non-2xx when processing fails.

// node:http, not fetch: fetch forces `sec-fetch-mode: cors` and adds a
// text/plain Content-Type, so it cannot send these header sets as written.
const { request: httpRequest } = await import("node:http");
const postFormWith = (obj, headers) => {
  const body = new URLSearchParams(obj).toString();
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${CALLBACK_PATH}`, { method: "POST", headers }, (r) => {
      r.resume();
      r.on("end", () => resolve({
        res: { status: r.statusCode, headers: { get: (n) => r.headers[n.toLowerCase()] ?? null } },
        body,
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
};
const HEADER_VARIANTS = {
  "Accept: text/html only": { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
  "Sec-Fetch-Mode: navigate only": { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Mode": "navigate" },
  "full browser headers": { "Content-Type": "application/x-www-form-urlencoded", ...BROWSER_HEADERS },
  "no browser headers": { "Content-Type": "application/x-www-form-urlencoded" },
  "no Content-Type at all": {},
  "unexpected Content-Type": { "Content-Type": "text/plain", Accept: "text/html" },
};

for (const [name, headers] of Object.entries(HEADER_VARIANTS)) {
  test(`form callback with ${name}: verify unavailable → 503, relay failure → 502, never 2xx/3xx`, async () => {
    const order = localOrder();
    const cb = callback({ orderid: order.id });
    verifyBook.set(cb.ap_transactionid, () => { throw Object.assign(new Error("t"), { code: "ECONNABORTED" }); });
    const unverifiable = await postFormWith(cb, headers);
    assert.equal(unverifiable.res.status, 503);
    assert.equal(unverifiable.res.headers.get("location"), null);
    assert.equal(orders.get(order.id).status, "pending");

    verifyBook.set(cb.ap_transactionid, recordFor(cb));
    kk.respond = () => new Response("down", { status: 500 });
    const relayFailed = await postFormWith(cb, headers);
    assert.equal(relayFailed.res.status, 502);
    assert.equal(relayFailed.res.headers.get("location"), null);

    // Re-send after recovery: processed and forwarded exactly once more.
    kk.respond = () => new Response("OK", { status: 200 });
    const resent = await postFormWith(cb, headers);
    assert.ok([200, 303].includes(resent.res.status));
    assert.equal(orders.get(order.id).status, "paid");
    assert.equal(kk.calls.length, 3, "2 failed attempts + 1 delivery");
  });
}

test("browser-headed callback claiming unconfirmed success: 503 page, not a redirect, not forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb, {
    transaction_status: "211", transaction_payment_status: "TRANSACTION IN PROCESS" }));
  const { res } = await postForm(cb);
  assert.equal(res.status, 503);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 0);
});

test("browser failure page for an external order has no redirect to follow", async () => {
  const cb = callback({ orderid: "66862257128204168" });
  verifyBook.set(cb.ap_transactionid, () => { throw new Error("net"); });
  const { res } = await postForm(cb);
  assert.equal(res.status, 503);
  const page = await res.text();
  assert.ok(!page.includes("http-equiv"), "no Firvanra order page for a KKChat order");
  assert.match(page, /We are confirming your payment/);
});

test("browser return for a verified pending payment: redirected, forwarded", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id, transaction_status: "211",
    transaction_payment_status: "TRANSACTION IN PROCESS", message: "Processing" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const { res } = await postForm(cb);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /status=pending&gateway=airpay_2$/);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(kk.calls.length, 1);
});

test("verify record from a different merchant is a mismatch: rejected, not forwarded", async () => {
  const cb = callback({ orderid: "KKC-other-mid" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb, { merchant_id: M1.AIRPAY_MERCHANT_ID }));
  assert.equal((await postServerForm(cb)).res.status, 400);
  assert.equal(kk.calls.length, 0);
});

test("KKChat timeout through the route: 502, bounded attempts, local settlement kept", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  const { res } = await postJson(cb);
  assert.equal(res.status, 502);
  assert.equal(kk.calls.length, 2);
  assert.equal(orders.get(order.id).status, "paid");
});

// ═════════════════════════════ Logging ═════════════════════════════════════

async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines;
}
const SUMMARY = "[airpay2 callback] summary ";
const summaries = (lines) => lines
  .filter((l) => l.startsWith(SUMMARY))
  .map((l) => JSON.parse(l.slice(SUMMARY.length)));

test("structured summary: unknown local order, verified, delivered; no secrets", async () => {
  const cb = callback({ orderid: "66862257128204167" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const lines = await captureLogs(() => postServerForm(cb));
  const [s] = summaries(lines);
  assert.deepEqual(s, {
    provider: "airpay2", channel: "ambiguous", format: "form",
    orderid: cb.orderid, ap_transactionid: cb.ap_transactionid,
    verification: "verified", outcome: "paid", local_order: "unknown",
    forwarding: { destination: "kkchat", status: "delivered", http_status: 200, attempts: 1 },
  });
  const all = lines.join("\n");
  for (const secret of Object.values(M2).filter((v) => v !== M2.AIRPAY_MID_2))
    assert.ok(!all.includes(secret), "no AirPay 2 credential in logs");
  assert.ok(!all.includes(cb.ap_SecureHash), "no secure hash in logs");
});

test("structured summary: failed relay and unverifiable callback are reported as such", async () => {
  const cb = callback({ orderid: "KKC-log-fail" });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  kk.respond = () => new Response("down", { status: 500 });
  const [failed] = summaries(await captureLogs(() => postJson(cb)));
  assert.equal(failed.forwarding.status, "failed");
  assert.equal(failed.forwarding.http_status, 500);
  assert.equal(failed.forwarding.attempts, 2);

  const cb2 = callback({ orderid: "KKC-log-unverified" });
  verifyBook.set(cb2.ap_transactionid, () => { throw new Error("net"); });
  const [unverified] = summaries(await captureLogs(() => postJson(cb2)));
  assert.equal(unverified.verification, "unavailable");
  assert.equal(unverified.forwarding.status, "not_forwarded");
});

// ═════════════════════════════ Public-domain routing ═══════════════════════

test("firvanra.online proxies the callback path to the API, before the SPA fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const fe = JSON.parse(await readFile(new URL("../../frontend/vercel.json", import.meta.url), "utf8"));
  assert.equal(fe.redirects, undefined, "no redirect: a 30x would turn AirPay's POST into a GET");
  const i = fe.rewrites.findIndex((r) => r.source === CALLBACK_PATH);
  assert.ok(i >= 0, "callback rewrite present");
  assert.equal(fe.rewrites[i].destination, `https://api.firvanra.online${CALLBACK_PATH}`);
  const spa = fe.rewrites.findIndex((r) => r.destination === "/index.html");
  assert.ok(i < spa, "callback rewrite precedes the SPA catch-all");

  const be = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(be.rewrites.some((r) => r.source === "/(.*)" && r.destination === "/server.js"),
    "API project hands every path to Express");
});

// The request as Vercel's external rewrite delivers it: Host is the API domain,
// the public domain survives only in X-Forwarded-Host, and any query string is
// passed through. node:http is used because fetch cannot set Host.
async function postProxied({ body, contentType, query = "", headers = {} }) {
  const http = await import("node:http");
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: `${CALLBACK_PATH}${query}`,
      headers: {
        Host: "api.firvanra.online",
        "X-Forwarded-Host": "firvanra.online",
        "X-Forwarded-Proto": "https",
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("proxied form IPN (Host: api.firvanra.online, query string): settled, forwarded verbatim", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const body = new URLSearchParams(cb).toString();

  const res = await postProxied({
    body, contentType: "application/x-www-form-urlencoded", query: "?src=airpay&x=1",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { received: true, forwarded: true, duplicate: false });
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(kk.calls.length, 1);
  assert.equal(kk.calls[0].url, KKCHAT, "destination not steered by Host / X-Forwarded-Host");
  assert.equal(kk.calls[0].body, body, "body byte-for-byte; the query string is not mixed in");
});

test("proxied JSON IPN: processed and forwarded with the original bytes", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));
  const body = JSON.stringify(cb, null, 2);

  const res = await postProxied({ body, contentType: "application/json", query: "?src=airpay" });
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "paid");
  assert.equal(kk.calls[0].body, body);
  assert.equal(kk.calls[0].contentType, "application/json");
});

test("proxied browser return: customer sent to FRONTEND_URL, not the API Host", async () => {
  const order = localOrder();
  const cb = callback({ orderid: order.id });
  verifyBook.set(cb.ap_transactionid, recordFor(cb));

  const res = await postProxied({
    body: new URLSearchParams(cb).toString(),
    contentType: "application/x-www-form-urlencoded",
    headers: BROWSER_HEADERS,
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location,
    `https://firvanra.online/order/${order.id}?status=pending&gateway=airpay_2&returnStatus=success`);
});

test("proxied forged callback: rejected, nothing verified or forwarded", async () => {
  const order = localOrder();
  const cb = { ...callback({ orderid: order.id }), ap_SecureHash: "123" };

  const res = await postProxied({
    body: new URLSearchParams(cb).toString(), contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
  assert.equal(verifyCalls().length, 0);
  assert.equal(kk.calls.length, 0);
});
