// Health-endpoint tests. Run: node --test server.health.test.js
//
// Imports the real server.js so this also covers the Vercel contract: the module
// must export the Express app, and must not bind a port when VERCEL is set.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";

// Set before importing server.js: with VERCEL set the module exports the app
// without calling app.listen(), which is exactly how Vercel loads it.
process.env.VERCEL = "1";

const app = (await import("./server.js")).default;

let server, base;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.VERCEL;
});

test("server.js exports the Express app for Vercel", () => {
  assert.equal(typeof app, "function");
});

test("GET /api/health returns ok:true", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "firvanra-api");
});

test("GET /api/health requires no authentication", async () => {
  // No cookie, no Authorization header, no API key.
  const res = await fetch(`${base}/api/health`, { headers: {} });
  assert.equal(res.status, 200);
});

test("GET /api/health/version reports the Vercel build, sanitised", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      VERCEL_GIT_COMMIT_SHA: "275ed38a1b2c3d4e5f60718293a4b5c6d7e8f901",
      VERCEL_GIT_COMMIT_REF: "fix/airpay2-kkchat-end-to-end-diagnostics",
      VERCEL_ENV: "preview",
    });
    const body = await (await fetch(`${base}/api/health/version`)).json();
    assert.deepEqual(body, {
      ok: true, service: "firvanra-api", commit: "275ed38a1b2c",
      ref: "fix/airpay2-kkchat-end-to-end-diagnostics", environment: "preview",
      airpay2_callback_path: "/callback/cpm/arp_firvanra/collection",
    });

    Object.assign(process.env, { VERCEL_GIT_COMMIT_SHA: "<script>", VERCEL_GIT_COMMIT_REF: "a b;c", VERCEL_ENV: "x" });
    const odd = await (await fetch(`${base}/api/health/version`)).json();
    assert.equal(odd.commit, "unknown");
    assert.equal(odd.ref, "unknown");
    assert.equal(odd.environment, "unknown");

    for (const k of ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF", "VERCEL_ENV"]) delete process.env[k];
    const none = await (await fetch(`${base}/api/health/version`)).json();
    assert.equal(none.commit, "unknown");
  } finally {
    for (const k of ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF", "VERCEL_ENV"])
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("/api/health/version exposes no credential presence or secrets", async () => {
  process.env.AIRPAY_PASSWORD_2 = "SHOULD-NOT-APPEAR";
  try {
    const text = await (await fetch(`${base}/api/health/version`)).text();
    for (const token of ["SHOULD-NOT-APPEAR", "AIRPAY_", "SECRET", "PASSWORD", "KKCHAT", "configured"])
      assert.ok(!text.toUpperCase().includes(token.toUpperCase()), `must not mention ${token}`);
  } finally {
    delete process.env.AIRPAY_PASSWORD_2;
  }
});

test("/api/health leaks no environment values, secrets or internals", async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();

  // Exactly the two advertised keys -- nothing else rides along.
  assert.deepEqual(Object.keys(body).sort(), ["ok", "service"]);

  const serialized = JSON.stringify(body);
  for (const token of [
    "AIRPAY", "SABPAISA", "PAYU", "SECRET", "KEY", "SALT", "PASSWORD",
    "NODE_ENV", "PUBLIC_BASE_URL", "FRONTEND_URL", "stack", "node_modules",
  ]) {
    assert.ok(
      !serialized.toUpperCase().includes(token.toUpperCase()),
      `/api/health response must not mention ${token}`,
    );
  }
});
