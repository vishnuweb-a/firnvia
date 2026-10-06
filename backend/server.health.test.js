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
