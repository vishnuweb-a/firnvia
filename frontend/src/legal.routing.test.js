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
  "/refund-and-cancellation-policy": ["RefundAndCancellationPolicy", 23],
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

// Pages added for the multi-page site. Paths with ":" are checked with a sample URL.
const PAGES = {
  "/shop": "Shop", "/product/:id": "ProductDetail", "/about": "About", "/faq": "Faq",
  "/policies": "Policies", "/contact": "ContactPage",
  "/shipping-and-delivery-policy": "ShippingAndDeliveryPolicy",
};

test("every content page is routed, in the header or footer, and has SEO copy", () => {
  const HEADER = src("./components/Header.jsx");
  const SEO = src("./seo.js");
  const spa = new RegExp("^" + VERCEL.rewrites.find((r) => r.destination === "/index.html").source + "$");
  for (const [path, comp] of Object.entries(PAGES)) {
    assert.match(MAIN, new RegExp(`path="${path}" element=\{<${comp} />\}`));
    assert.ok(spa.test(path.replace(":id", "wordpress-care")), `rewrite ${path}`);
    if (path.includes(":")) continue;
    assert.ok(HEADER.includes(`"${path}"`) || FOOTER.includes(`to="${path}"`), `nav ${path}`);
    assert.ok(SEO.includes(`"${path}":`), `seo ${path}`);
  }
  for (const label of ["FAQ", "Policies"]) assert.ok(HEADER.includes(`"${label}"`), label);
});

test("payment and callback rewrites still come before the SPA fallback", () => {
  const sources = VERCEL.rewrites.map((r) => r.source);
  const spaAt = sources.indexOf("/((?!api/).*)");
  assert.equal(spaAt, sources.length - 1);
  for (const s of ["/api/:path*", "/callback/cpm/arp_firvanra/collection", "/payments/hdfc/return"])
    assert.ok(sources.indexOf(s) > -1 && sources.indexOf(s) < spaAt, s);
});

test("product page copy exists for exactly the listed catalogue, test product excluded", async () => {
  const { products } = await import("../../backend/data/products.js");
  const listed = products.filter((p) => p.type === "service" || p.type === "ebook").map((p) => p.id).sort();
  const copy = [...src("./content/products.js").matchAll(/^  "([a-z0-9-]+)": \{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(copy, listed);
  assert.ok(!copy.includes("sabpaisa-test-10"));
});

test("FAQ accordion uses real buttons with expanded state", () => {
  const FAQ = src("./pages/Faq.jsx");
  assert.match(FAQ, /<button[^>]*aria-expanded=\{open\}[^>]*aria-controls/);
  assert.match(FAQ, /hidden=\{!open\}/);
  const questions = FAQ.match(/^    \["/gm) || [];
  assert.ok(questions.length >= 12 && questions.length <= 15, `questions: ${questions.length}`);
});

test("checkout consent starts unchecked and blocks payment when missing", () => {
  assert.match(CHECKOUT, /useState\(false\)/);
  assert.match(CHECKOUT, /if \(!agreed\)/);
  assert.ok(CHECKOUT.indexOf("if (!agreed)") < CHECKOUT.indexOf("api.createOrder"));
  for (const path of Object.keys(ROUTES)) assert.ok(CHECKOUT.includes(path), path);
});

test("no placeholder testimonials, log-only enquiry form or unapproved refund timings", () => {
  assert.doesNotMatch(src("./pages/Home.jsx"), /Testimonials/);
  const CONTACT = src("./components/Contact.jsx");
  assert.doesNotMatch(CONTACT, /<form|api\.contact/);
  assert.match(CONTACT, /mailto:/);
  assert.match(CONTACT, /tel:/);
  assert.doesNotMatch(src("./api.js"), /contact/);
  assert.doesNotMatch(src("./pages/RefundAndCancellationPolicy.jsx"), /proposed within|\d+ business days/);
});

test("policies name no fixed gateway list; kkchat sharing stays disclosed", () => {
  for (const page of ["TermsAndConditions", "RefundAndCancellationPolicy"])
    assert.doesNotMatch(src(`./pages/${page}.jsx`), /AirPay|SabPaisa|PayU/, page);
  assert.match(src("./pages/DataNotice.jsx"), /kkchat\.in/);
});

test("favicon is linked and exists", () => {
  assert.match(readFileSync(new URL("../index.html", import.meta.url), "utf8"), /rel="icon"[^>]*href="\/favicon\.svg"/);
  assert.match(readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8"), /^<svg /);
});
