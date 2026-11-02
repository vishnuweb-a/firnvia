// Source-level checks (the project has no DOM test framework) for the legal
// pages: routes, footer links, checkout consent and the SPA rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const MAIN = src("./main.jsx");
const FOOTER = src("./components/Footer.jsx");
const CHECKOUT = src("./pages/Checkout.jsx");
const VERCEL = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

const ROUTES = {
  "/terms-and-conditions": ["TermsAndConditions", 25],
  "/refund-and-cancellation-policy": ["RefundAndCancellationPolicy", 22],
  "/privacy-policy": ["DataNotice", 23],
};

test("each legal route is registered with its page", () => {
  for (const [path, [comp]] of Object.entries(ROUTES))
    assert.match(MAIN, new RegExp(`path="${path}" element=\{<${comp} />\}`));
});

test("legal pages contain the required number of sections", () => {
  for (const [, [comp, n]] of Object.entries(ROUTES)) {
    const ids = src(`./pages/${comp}.jsx`).match(/^\s*\{ id: "/gm) || [];
    assert.equal(ids.length, n, comp);
  }
});

test("footer links are internal routes, never href=\"#\"", () => {
  assert.doesNotMatch(FOOTER, /href="#"/);
  for (const path of Object.keys(ROUTES)) assert.ok(FOOTER.includes(`to="${path}"`), path);
  assert.doesNotMatch(FOOTER, /href="#(home|services|contact)"/); // would break on nested routes
});

test("SPA rewrite serves index.html for policy URLs but not /api", () => {
  const spa = VERCEL.rewrites.find((r) => r.destination === "/index.html");
  const re = new RegExp("^" + spa.source + "$");
  for (const path of Object.keys(ROUTES)) assert.ok(re.test(path), path);
  assert.ok(!re.test("/api/orders"));
});

test("checkout consent starts unchecked and blocks payment when missing", () => {
  assert.match(CHECKOUT, /useState\(false\)/);
  assert.match(CHECKOUT, /if \(!agreed\)/);
  assert.ok(CHECKOUT.indexOf("if (!agreed)") < CHECKOUT.indexOf("api.createOrder"));
  for (const path of Object.keys(ROUTES)) assert.ok(CHECKOUT.includes(path), path);
});
