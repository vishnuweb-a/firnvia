# Current Project Audit

> **Scope.** Static read-only audit of `C:\Users\Coder\Desktop\firnviaNew`, performed 2026-10-06 before integrating a new payment gateway. No code was modified, no dependencies installed, nothing executed. 33 source files total (excluding `node_modules` / lockfiles). Every path below was verified by reading the file. Items that could not be verified are explicitly marked **UNVERIFIED**.

---

## 1. Executive Summary

The workspace holds two sibling applications under one folder — `backend/` (Node + Express API) and `frontend/` (React + Vite SPA) — for a brand called **Firvanra** (`firvanra.online`), an Indian IT-services agency selling six service packages and four ebooks in INR.

The project is a **small, complete, working e-commerce slice**: the frontend lists products from the API, maintains a localStorage cart, collects billing details, and posts an order; the backend prices the order server-side, stores it, and hands back an auto-submit payment form.

**Payment functionality already exists** — and not for one gateway but two:

- **AirPay v4** — fully implemented (OAuth2 → AES-256-CBC encrypted form → hosted checkout → CRC32-verified callback). This is the path the frontend actually uses.
- **SabPaisa PG 3.0** — fully implemented on the backend (REST initiate → `checkoutUrl` redirect → callback + HMAC-signed webhook with idempotency). **The frontend never calls it.** It is reachable only by hitting the API directly.

So the task ahead is not a greenfield integration but **adding a third gateway to an existing two-gateway codebase**, and the pre-existing abstraction is weak: `routes/payment.js` hardcodes a per-gateway pair of routes rather than dispatching through a common provider interface.

Three structural facts dominate the risk picture:

1. **There is no database.** Orders live in a JavaScript `Map` in process memory (`backend/routes/orders.js:6`). Every restart, crash, or deploy erases all orders — including paid ones. A real payment can succeed at the gateway while the order it paid for no longer exists.
2. **Real production-looking credentials are committed in `backend/.env`, and there is no `.gitignore` anywhere.** Marked **CRITICAL** below.
3. **There is no deployment configuration of any kind** and the repository is not a git repository, so production topology is inferred from URLs in the code, not verified.

The good news for the upcoming work: the **server-side pricing model is already correct**. The frontend sends only `{id, qty}`; the backend resolves price from its own catalog. The single most common payment vulnerability is already avoided by design.

**Readiness: MOSTLY READY** (see §19) — the payment *plumbing* is mature and reusable; the *persistence and secrets* layers are not production-safe.

---

## 2. Frontend Technology Stack

| Aspect | Finding | Evidence |
|---|---|---|
| **Framework** | React 18.3.1 (SPA, no SSR) | `frontend/package.json:12-13` |
| **Language** | JavaScript (ESM, `"type": "module"`). **No TypeScript** — no `tsconfig.json`, no `.ts`/`.tsx` files | `frontend/package.json:5` |
| **Runtime** | Browser; Node only for tooling | — |
| **Styling** | One hand-written global stylesheet with CSS custom properties (`--accent-deep`, `--muted`). **No Tailwind, no CSS modules, no CSS-in-JS.** Heavy use of inline `style={{}}` props | `frontend/src/styles/global.css`, e.g. `Checkout.jsx:66` |
| **Routing** | `react-router-dom` 6.26.2, `BrowserRouter`, 3 routes | `frontend/src/main.jsx:13-19` |
| **State Management** | React Context + `useReducer` for the cart only. **No Redux / Zustand / React Query** | `frontend/src/context/CartContext.jsx` |
| **API Client** | Hand-rolled `fetch` wrapper. **No axios in the frontend** (axios exists only in the backend) | `frontend/src/api.js` |
| **Build System** | Vite 5.4.8 + `@vitejs/plugin-react` | `frontend/vite.config.js` |
| **Package Manager** | npm (`package-lock.json` present; no yarn/pnpm lockfile) | `frontend/package-lock.json` |
| **Entry Point** | `frontend/index.html` → `frontend/src/main.jsx` | `index.html:10` |
| **Deployment** | **None configured.** No `vercel.json`, `netlify.toml`, Dockerfile, or CI | verified absent |

Only **three** runtime dependencies — react, react-dom, react-router-dom. No payment SDK is loaded client-side, which is architecturally correct (all gateway crypto stays server-side).

---

## 3. Frontend Architecture

```text
frontend/
├── index.html                 Vite entry; mounts #root
├── vite.config.js             Dev server :5173 + /api proxy → :4000
├── package.json
└── src/
    ├── main.jsx               ReactDOM root; CartProvider → BrowserRouter → Routes
    ├── App.jsx                Shared chrome (Header + CartDrawer); NOT a router
    ├── api.js                 Single centralized API layer — all 5 backend calls
    ├── pages/                 Route-level screens (3)
    │   ├── Home.jsx           Landing page; fetches product catalog
    │   ├── Checkout.jsx       Billing form + order creation + payment hand-off
    │   └── OrderStatus.jsx    Post-payment success/failure/pending screen
    ├── components/            Presentational + cart UI (9)
    │   ├── Header.jsx         Nav + cart button with item-count badge
    │   ├── CartDrawer.jsx     Slide-over cart: qty +/−, remove, → /checkout
    │   ├── Hero.jsx           Landing hero
    │   ├── Services.jsx       Service products grid ("Buy now @ ₹N")
    │   ├── EbookShop.jsx      Ebook products grid ("Add to cart")
    │   ├── MicroServices.jsx  Static marketing copy (hardcoded, NOT purchasable)
    │   ├── Testimonials.jsx   Static marketing copy
    │   ├── Contact.jsx        Contact form → POST /api/contact
    │   └── Footer.jsx
    ├── context/
    │   └── CartContext.jsx    Cart reducer + localStorage persistence
    └── styles/
        └── global.css         All styling
```

**Directories that do NOT exist** (worth noting against the brief's checklist): no `services/`, no `hooks/`, no `store/`, no `utils/`, no `data/`, no `assets/`, and — importantly — **no `public/` directory**.

**Notable architectural observations:**

- `App.jsx` is a layout wrapper, not an application root. Each page imports and wraps itself in it (`Checkout.jsx:59`). It supports a function-as-children render prop so `Home.jsx` can receive `openCart` (`App.jsx:10`, `Home.jsx:24`).
- **There is no authentication anywhere in the frontend** — no login, no token storage, no user context, no protected routes. Checkout is fully anonymous (guest-only).
- **No `.env` file and no `import.meta.env` usage.** The backend URL is not configurable at build time; it is hardcoded as the relative path `/api` (`api.js:1`). See §9 for why this breaks in production.
- **Broken image references:** products carry `image: "/img/services/*.png"` paths, but no `public/` folder exists, so these resolve to 404. `EbookShop.jsx:19` even carries the comment `{/* Replace with <img src={b.image} .../> */}` — images are deliberately not rendered yet. Low severity, cosmetic.

---

## 4. Frontend Screens / Routes

| Route | Screen | File | Purpose |
|---|---|---|---|
| `/` | Home | `frontend/src/pages/Home.jsx` | Fetches full catalog on mount, splits by `type` into services/ebooks, renders marketing sections + contact form |
| `/checkout` | Checkout | `frontend/src/pages/Checkout.jsx` | Billing-details form, order summary, creates order then initiates AirPay payment |
| `/order/:id` | OrderStatus | `frontend/src/pages/OrderStatus.jsx` | Reads order by id, shows paid / failed / pending; honours `?status=` and `?sim=` query params |

**Also present but not routes:** the cart is a drawer overlay (`CartDrawer.jsx`) rather than a page, and in-page anchors `#home`, `#services`, `#about`, `#contact` appear in `Header.jsx:14-17`. Note `#about` has **no matching section id** in the codebase — a dead nav link (LOW).

**Route gap — confirmed defect.** `backend/data/products.js:100-101` adds a hidden ₹10 test product with the comment *"only accessible via `/payment-test`, never shown in product listings"*. **No `/payment-test` route exists** in `main.jsx`, and no file references it. Either the page was deleted or never built. Two consequences:

- The intended manual gateway-test harness is missing.
- The test product is **not** actually hidden: `GET /api/products` with no `type` filter returns the entire array including `sabpaisa-test-10` (`routes/products.js:8`). It escapes the UI only because `Home.jsx:19-20` filters for `type === "service" | "ebook"`, and `"test"` matches neither. The exclusion is incidental, not enforced.

---

## 5. Product Architecture

**Current product source: a single backend JavaScript module, served over HTTP.**

`backend/data/products.js` exports a hardcoded `products` array — 10 visible products plus 1 hidden test product — and a `getProduct(id)` lookup helper (`:103`). There is **no database table, no product model, and no admin UI**. The frontend holds **no local catalog whatsoever**; it fetches everything from `GET /api/products` on mount (`Home.jsx:16`).

This is already very close to the "lightweight JS/JSON catalog" the brief contemplates in Step 6 — **it exists, and it is already on the correct side of the trust boundary** (see §6).

**Product structure (verified shape):**

```js
{
  id:       "website-redesign-mini",   // string slug, used as the trusted price key
  type:     "service",                 // "service" | "ebook" | "test"
  title:    "Website Redesign Mini",
  blurb:    "A modern, clean refresh ...",
  price:    849,                       // INR rupees, integer — NOT paise
  image:    "/img/services/redesign.png",
  category: "ebooks"                   // ebooks only; services omit it
}
```

**Pricing.** Prices are plain integer **rupees** (₹499–₹999 services, ₹129–₹399 ebooks, ₹10 test). The file comment at `data/products.js:2` states *"paise are computed at payment time"*, which holds: `services/sabpaisa.js:26` does `Math.round(order.total * 100)`, while `services/airpay.js:129` sends `order.total.toFixed(2)` (rupees with decimals). **The two gateways take different amount units** — a trap for the next integration (see §15, MEDIUM).

Display formatting is duplicated as a one-line `inr()` helper in **five** files (`Services.jsx:3`, `EbookShop.jsx:3`, `CartDrawer.jsx:4`, `Checkout.jsx:8`, `OrderStatus.jsx:7`) — minor duplication, no shared `utils/`.

**Product selection flow.** Verified end-to-end:

```text
Home.jsx mounts
  → api.products()  →  GET /api/products
  → split by p.type into services[] / ebooks[]
  → Services.jsx  "Buy now @ ₹N"  →  add(s)  ──┐
  → EbookShop.jsx "Add to cart"   →  add(b)  ──┤
                                               ▼
                              CartContext: add → qty=1, or qty+1 if present
                                  (persisted to localStorage "firvanra_cart")
                                               │
                              onAdded() → opens CartDrawer
                                               ▼
                   CartDrawer: adjust qty / remove  →  "Checkout"
                                               ▼
                   navigate("/checkout")  →  Checkout.jsx
```

**Answers to the Step 2 checklist:**

| Question | Answer |
|---|---|
| Where are products stored? | `backend/data/products.js` (in-code array) |
| Hardcoded? | Yes, in backend source |
| From backend APIs? | Yes — `GET /api/products` |
| Local frontend catalog file? | **No** — none |
| How are prices displayed? | `inr()` → `₹N.toLocaleString("en-IN")` |
| Can users select products? | Yes — add-to-cart buttons |
| Do quantities exist? | Yes — cart `+`/`−`, server clamps to `≥1` |
| Does a cart exist? | Yes — Context + localStorage |
| Checkout screen? | Yes — `/checkout` |
| "Buy Now" button? | Yes (label only — `Services.jsx:25` adds to cart, it does not skip to checkout) |
| Customer info collected? | Yes — firstName, lastName, email, phone |

**Note:** the "Buy now @ ₹N" button is a **mislabel**, not a feature — there is no single-click direct-purchase path. Everything funnels through the cart. If a true Buy Now flow is wanted for the new gateway, it does not exist yet.

---

## 6. Backend Technology Stack

| Aspect | Finding | Evidence |
|---|---|---|
| **Framework** | Express 4.19.2 | `backend/package.json:15` |
| **Language** | JavaScript (ESM, `"type": "module"`). No TypeScript | `backend/package.json:6` |
| **Runtime** | Node.js. Uses global `fetch` → **requires Node ≥ 18**; also `node --watch` → Node ≥ 18.11. **No `engines` field declares this** (`server.js:36`, `package.json:9`) |
| **Database** | **NONE.** No DB driver, no ORM, no connection string. Orders in an in-memory `Map` | `backend/routes/orders.js:6` |
| **Authentication** | **NONE.** No auth middleware, no JWT, no sessions, no API keys on any route | verified across all routes |
| **Authorization** | **NONE** | — |
| **Validation** | Hand-written presence checks only. No Joi/Zod/express-validator | `routes/contact.js:8`, `routes/orders.js:13` |
| **Logging** | `console.log` / `console.error` only. No winston/pino, no request logger, no log levels | throughout |
| **Error Handling** | Per-route `try/catch`. **No global Express error-handling middleware**, no 404 handler | `routes/payment.js:52` |
| **Package Manager** | npm | `backend/package-lock.json` |
| **Entry Point** | `backend/server.js`; `npm start` → `node server.js`, `npm run dev` → `node --watch server.js` | `package.json:8-9` |
| **Deployment** | **None configured** | verified absent |

**Dependencies (6, all runtime):** `express`, `cors`, `axios` (gateway HTTP), `crypto` (Node builtin — AES/HMAC/SHA), `crc-32` (AirPay `ap_SecureHash`), `nanoid` (order ids), `dotenv`. No dev dependencies, **no test framework, and no tests at all**.

---

## 7. Backend Architecture

```text
backend/
├── server.js                  Entry: CORS, body parsers, route mounting, SabPaisa forwarder
├── package.json
├── .env                       ⚠ REAL CREDENTIALS COMMITTED — see §15 CRITICAL
├── .env.example               Template (AirPay only; SabPaisa vars MISSING)
├── data/
│   └── products.js            Trusted product catalog + getProduct(id)
├── routes/
│   ├── products.js            GET / (optional ?type= filter)
│   ├── orders.js              POST / (create, server-priced), GET /:id  + exports `orders` Map
│   ├── payment.js             AirPay + SabPaisa initiate/callback/webhook/simulate
│   └── contact.js             POST / — validates then console.logs; persists NOTHING
├── services/
│   ├── airpay.js              AirPay v4: OAuth2, AES-256-CBC, SHA-256 checksum, CRC32 verify
│   └── sabpaisa.js            SabPaisa PG 3.0: HMAC checksum, initiate, webhook verify
└── {routes,services,data}/    ⚠ EMPTY STRAY DIRECTORY (shell brace-expansion accident,
                               created 2026-06-20). Harmless; safe to delete.
```

**Layering.** A clean, if thin, three-layer split: `routes/` (HTTP) → `services/` (gateway protocol + crypto) → `data/` (catalog). There is **no `controllers/`, `models/`, `middleware/`, `repositories/`, `database/`, or `config/` directory**, and no central config module — each service reads `process.env` directly into a local `cfg` object (`airpay.js:26`, `sabpaisa.js:8`).

**`server.js` details worth flagging:**

- **CORS** (`:11`): single origin from `FRONTEND_URL`, default `http://localhost:5173`. `credentials` is **not** enabled (consistent — nothing uses cookies).
- **Raw body capture** (`:14-16`): `express.json({ verify })` stashes `req.rawBody`, correctly enabling byte-exact HMAC webhook verification. This is a genuinely well-done detail and the new gateway should reuse it.
- **Both parsers mounted** (`:14-18`): JSON *and* `urlencoded`, because AirPay posts form-encoded callbacks. Correct.
- **A second, independent SabPaisa callback endpoint at `/callback/cpm/sapa/collection`** (`:49-50`), outside `/api`, which logs the payload and blind-forwards it to `https://kkchat.in/callback/cpm/sapa/collection` (`:28`). It performs **no signature verification and updates no order** — it only forwards and returns `200 {status:"received"}`.

**The `kkchat.in` forwarding (8 references across `server.js` and `routes/payment.js`) is unexplained by anything in the repository.** It appears in three places: the standalone callback above, `forwardToKkchat()` on the SabPaisa redirect callback (`payment.js:119`), and again on the SabPaisa webhook (`payment.js:179`). It forwards **full payment payloads to an unrelated third-party domain**, fire-and-forget. **UNVERIFIED:** whether this is an intentional partner/aggregator relay or leftover debug scaffolding. Flagged HIGH in §15 — this must be confirmed with the project owner before the new gateway is wired, because the same pattern will likely be copied.

---

## 8. API Inventory

Base prefix `/api` for all application routes (plus one non-prefixed callback).

| Method | Endpoint | Handler | Purpose | Frontend Consumer |
|---|---|---|---|---|
| GET | `/api/health` | `server.js:20` | Liveness probe → `{ok:true}` | **none** |
| GET | `/api/products` | `routes/products.js:6` | Catalog; optional `?type=service\|ebook` | `api.js:17` ← `Home.jsx:16` |
| POST | `/api/orders` | `routes/orders.js:11` | Create order from `[{id,qty}]` + buyer; **server-side pricing** | `api.js:18` ← `Checkout.jsx:25` |
| GET | `/api/orders/:id` | `routes/orders.js:37` | Fetch order by id | `api.js:20` ← `OrderStatus.jsx:16` |
| POST | `/api/contact` | `routes/contact.js:6` | Contact form; validates then **logs only** | `api.js:25` ← `Contact.jsx:15` |
| POST | `/api/payment/airpay/initiate` | `routes/payment.js:35` | Build encrypted AirPay auto-submit form | `api.js:21` ← `Checkout.jsx:29` |
| POST | `/api/payment/airpay/callback` | `routes/payment.js:58` | CRC32-verify, mark paid/failed, 302 to frontend | gateway (browser POST) |
| POST | `/api/payment/airpay/simulate/:orderId` | `routes/payment.js:74` | **Force order to `paid`, no auth** | `api.js:23` ← `Checkout.jsx:33` |
| POST | `/api/payment/sabpaisa/initiate` | `routes/payment.js:85` | Create SabPaisa txn → `checkoutUrl` | **none — ORPHANED** |
| GET | `/api/payment/sabpaisa/callback` | `routes/payment.js:138` | Redirect callback (query params) | gateway |
| POST | `/api/payment/sabpaisa/callback` | `routes/payment.js:139` | Redirect callback (body) | gateway |
| POST | `/api/payment/sabpaisa/webhook` | `routes/payment.js:156` | HMAC-verified S2S webhook + idempotency | gateway |
| POST | `/api/payment/sabpaisa/simulate/:orderId` | `routes/payment.js:141` | **Force order to `paid`, no auth** | **none — ORPHANED** |
| GET | `/callback/cpm/sapa/collection` | `server.js:49` | Health echo → `{status:"active"}` | gateway/monitoring |
| POST | `/callback/cpm/sapa/collection` | `server.js:50` | Log + forward to kkchat.in; **no verification** | gateway |

**15 endpoints; the frontend consumes only 5.** Unused/orphaned: both SabPaisa initiate+simulate, the entire `/callback/cpm/sapa/collection` pair, and `/api/health`.

**Request/response format.** JSON in, JSON out, except: AirPay callbacks arrive form-encoded; the payment callbacks respond with **HTTP 302 redirects** to the frontend rather than JSON. No API versioning, no pagination, no envelope — handlers return bare objects (`res.json(order)`).

---

## 9. Frontend ↔ Backend Communication

**One centralized client, one transport, no auth.** All traffic flows through `frontend/src/api.js` — a 26-line `fetch` wrapper that prefixes `/api`, sets `Content-Type: application/json`, `JSON.stringify`s bodies, and on `!res.ok` throws `new Error(err.error || ...)` (`api.js:9-12`). This pairs cleanly with the backend's consistent `{error: "..."}` shape, so errors surface as readable UI text.

**Base URL resolution — and the production gap.**

```text
base = "/api"                          (api.js:1 — a RELATIVE path, hardcoded)

Development:  browser :5173  →  Vite proxy  →  http://localhost:4000
              (vite.config.js:8  proxy: { "/api": "http://localhost:4000" })

Production:   browser  →  /api on the FRONTEND's own origin  →  ???
```

The Vite proxy is a **dev-server-only** facility; it does not exist in `vite build` output. In production `/api` resolves against whatever origin serves the SPA. **There is no `VITE_*` variable, no `.env` file, and no `import.meta.env` reference anywhere in the frontend** — so the backend URL cannot be configured at build time. This works **only** if frontend and backend are served from one origin behind a reverse proxy; it breaks silently (404s on every call) under split-host deployment such as Vercel + Render. Flagged HIGH in §15.

**Authentication mechanism: none.** No bearer tokens, no cookies, no CSRF tokens, no sessions. `credentials` is not set on any fetch, and CORS does not enable credentials (`server.js:11`). Every endpoint — including both `simulate` endpoints that mark orders paid — is fully public.

**CORS.** Single allowed origin from `FRONTEND_URL`. Fine for the SPA. Note that gateway callbacks are server-to-server or top-level browser POSTs, so CORS does not gate them.

**Verified end-to-end traces.**

Catalog:
```text
Home.jsx:16  api.products()  →  GET /api/products
  → server.js:21 → routes/products.js:6 → data/products.js  → 200 [products]
```

Checkout (the live payment path):
```text
Checkout.jsx:25  api.createOrder(items.map({id,qty}), buyer)
  → POST /api/orders → routes/orders.js:11
      getProduct(id) per line, server price, total, status:"pending",
      id = `FIR-${nanoid(10)}`, orders.set(...)
  → 200 order

Checkout.jsx:29  api.initiatePayment(order.id)
  → POST /api/payment/airpay/initiate → routes/payment.js:35
      → airpayConfigured()?
         NO  → {simulated:true}
               → Checkout.jsx:33 api.simulatePayment() → status="paid"
               → navigate(/order/:id?status=success&sim=1)
         YES → services/airpay.js:120 buildCheckoutForm()
               → getAccessToken() (OAuth2, encrypted)
               → {action, method, fields:{privatekey, merchant_id, encdata, checksum}}
               → Checkout.jsx:39-51 builds a hidden <form>, clear(), f.submit()
               → browser leaves the SPA for AirPay's hosted page
```

Return leg:
```text
AirPay → POST /api/payment/airpay/callback (form-encoded)
  → payment.js:59 airpayVerify(body) → CRC32 ap_SecureHash check
  → ok && paid → order.status="paid", paidAt, apTransactionId
  → 302 {FRONTEND_URL}/order/{id}?status=success     (or ?status=failed)
  → OrderStatus.jsx:16 api.getOrder(id) → GET /api/orders/:id → renders
```

**Broken, unused, and mismatched connections — findings:**

1. **SabPaisa is entirely orphaned from the frontend.** `api.js` exposes only `airpay/*`. A grep for `sabpaisa` across `frontend/` returns **zero** matches. The full SabPaisa implementation — initiate, callback, HMAC webhook, idempotency — is unreachable through the UI. **UNVERIFIED:** whether SabPaisa superseded AirPay (its PG 3.0 code is newer and better-engineered, and `payment.js:155` names a live production URL `https://firvanra.online/api/payment/sabpaisa/webhook`) or was abandoned mid-migration. This materially affects the new integration: **ask which gateway the new one replaces.**
2. **`GET /api/health` is never consumed** — no uptime monitor configured in-repo.
3. **`/payment-test` route missing** while `data/products.js:101` depends on it (see §4).
4. **Hidden test product leaks** through unfiltered `GET /api/products`.
5. **`#about` nav anchor** has no target section (LOW).
6. **Product images 404** — no `public/` directory (LOW).
7. **`clear()` fires before `f.submit()`** (`Checkout.jsx:50`): the cart is emptied the instant the user is sent to the gateway. If they abandon payment and come back, the cart is gone and the order is stranded in `pending`. MEDIUM UX/data defect.

---

## 10. Current Payment Implementation

**Payment functionality exists.** Two separate gateway integrations are present, both substantially complete. This is explicitly **not** a from-scratch integration.

### 10a. AirPay v4 — implemented AND wired to the UI

- **Provider:** AirPay (airpay.co.in), India/INR, "Simple Transaction" v4 flow.
- **Files:** `backend/services/airpay.js` (175 lines), `backend/routes/payment.js:35-81`, `frontend/src/pages/Checkout.jsx:29-51`, `frontend/src/api.js:21-24`.
- **Credential gate:** `airpayConfigured()` (`airpay.js:42`) requires merchantId, username, password, secret, clientId, clientSecret; if any is missing the route returns `{simulated:true}` and the UI runs a fake-success path.

**Crypto primitives (documented at `airpay.js:5-11`, implemented `:45-85`):**

| Primitive | Implementation |
|---|---|
| AES key | `md5(username + "~:~" + password)` → 32 hex chars = AES-256 key |
| Encrypt | 16-char hex IV prefix + base64(AES-256-CBC(json)) |
| Checksum | `sha256(values-sorted-by-key-concatenated + YYYY-MM-DD in IST)` |
| privatekey | `sha256(secret + "@" + username + ":|:" + password)` |
| Callback verify | `crc32(orderid:apTxnId:amount:txnStatus:message:mid:username)`, `>>> 0` for unsigned |

**Flow:** OAuth2 `client_credentials` POST to `AIRPAY_OAUTH_URL` with encrypted payload → decrypt token → build `{privatekey, merchant_id, encdata, checksum}` → return to browser → JS builds hidden form → POST to `{payUrl}?token=...` → user pays → AirPay POSTs form-encoded callback → CRC32 verify → order updated → 302 to `/order/:id`.

**Payment considered successful when** `transaction_status === "200"` **OR** `transaction_payment_status === "SUCCESS"` (`airpay.js:168-170`). Field names are read in both v4-lowercase and legacy-uppercase forms via a `pick()` helper (`:150`), with an honest comment that casing must be confirmed against a real sandbox callback — **UNVERIFIED** in-repo.

**Two significant weaknesses in AirPay verification:**

- **`hashOk` defaults to `true` when the hash is absent** (`airpay.js:167`: `!received || computed === received`). A forged callback that simply omits `ap_SecureHash` passes verification. **CRITICAL** (§15).
- **The callback amount is never compared to `order.total`.** Status and hash are checked; the paid amount is read (`:158`) but never validated.

### 10b. SabPaisa PG 3.0 — implemented, NOT wired to the UI

- **Provider:** SabPaisa, `https://merchant-api.sabpaisa.in/api/v2/payments`.
- **Files:** `backend/services/sabpaisa.js` (121 lines), `backend/routes/payment.js:85-197`, `backend/server.js:28-50`.
- **Frontend consumer: NONE.**
- **Checksum:** `HMAC-SHA256(merchantId|merchantTxnId|amount|currency|timestamp, SABPAISA_SECRET_KEY)` (`sabpaisa.js:19-22`).
- **Amount unit:** **paise** — `Math.round(order.total * 100)` (`:26`). Differs from AirPay's rupees-with-decimals.
- **Flow:** POST payload + `X-Api-Key` header → response `checkoutUrl` (+ optional `clientSecret` appended as a query param, `:64-66`) → frontend would redirect → customer pays → callback and/or webhook.

**Webhook handling is the strongest code in the repository** (`payment.js:156-197`):

- Signature header `X-SabPaisa-Signature`, format `{timestamp}.{base64_hmac_sha256}` over `timestamp + "." + rawBody` using the **exact raw bytes** captured in `server.js:15` — never re-serialized. Correct.
- **Replay protection:** rejects timestamps older than 5 minutes (`sabpaisa.js:85`).
- **Timing-safe comparison** via `crypto.timingSafeEqual` with a length pre-check (`:92-96`).
- **Idempotency:** `processedWebhooks` Set keyed on `idempotency_key`; duplicates short-circuit with `200` (`payment.js:152, 170-176`). Correctly returns `200` on unknown orders so the gateway stops retrying (`:184`).
- Maps events: `payment.success` + `status==="SUCCESS"` → paid; `payment.failed|expired|timeout` → failed (`:187-193`).

**Two serious weaknesses:**

- **`verifyWebhookSignature` returns `{ok:true, skipped:true}` when `SABPAISA_WEBHOOK_SECRET` is unset** (`sabpaisa.js:75`) — and **that variable is absent from `.env` and `.env.example`**. In the current configuration, **webhook signature verification is entirely bypassed**, so any unauthenticated POST can mark an order paid. **CRITICAL** (§15).
- **`verifyCallback` hardcodes `ok = true`** with the comment *"Accept all SabPaisa callbacks; rely on status field"* (`sabpaisa.js:115`). The checksum is computed and logged but deliberately **not enforced** (`:110-113`). The redirect callback therefore trusts an attacker-controllable `status` field. **CRITICAL** (§15). Note `payment.js:123` branches on `result.paid` and ignores `result.ok` entirely — so even restoring verification would require a route change.

### 10c. Simulation / test paths

`POST /api/payment/{airpay,sabpaisa}/simulate/:orderId` (`payment.js:74, 141`) set any order to `paid` with **no authentication, no environment guard, and no feature flag**. Intended for credential-less local development, but they are live on every deployment. **CRITICAL** (§15).

### 10d. Payment flow diagram (as currently implemented)

```text
                        ┌─────────── AirPay (LIVE PATH) ────────────┐

  Browser (Checkout.jsx)
      │
      │ POST /api/orders           {items:[{id,qty}], buyer}
      ▼
  Backend  routes/orders.js ── getProduct(id) → TRUSTED price → total
      │                        orders.set("FIR-xxx", {status:"pending"})
      │ 200 order
      ▼
  Browser
      │ POST /api/payment/airpay/initiate   {orderId}
      ▼
  Backend  routes/payment.js:35
      │        └─ airpayConfigured() == false ──► {simulated:true}
      │                                             │ POST /simulate/:id
      │                                             ▼ status="paid"  (NO AUTH)
      │                                          /order/:id?status=success&sim=1
      │
      │ services/airpay.js: OAuth2 token → AES-256-CBC encdata + sha256 checksum
      │ 200 {action, method, fields}
      ▼
  Browser  builds hidden <form>, clear() cart, f.submit()
      │
      ▼
  AirPay hosted checkout  ── customer pays ──┐
                                             │ POST (form-encoded) callback
                                             ▼
                              /api/payment/airpay/callback
                                 crc32 ap_SecureHash verify
                                 (⚠ passes if hash ABSENT)
                                 (⚠ amount never re-checked)
                                 order.status = paid | failed
                                             │ 302
                                             ▼
                              {FRONTEND_URL}/order/:id?status=...
                                             │ GET /api/orders/:id
                                             ▼
                                      OrderStatus.jsx


              ┌────── SabPaisa (IMPLEMENTED, NO FRONTEND CALLER) ──────┐

  (no UI caller)
      │ POST /api/payment/sabpaisa/initiate  {orderId}
      ▼
  Backend  services/sabpaisa.js
      │   HMAC-SHA256 checksum, amount in PAISE, X-Api-Key
      │   POST https://merchant-api.sabpaisa.in/api/v2/payments
      ▼
  SabPaisa ── {checkoutUrl, clientSecret} ──► would redirect customer
      │
      ├── browser redirect ─► GET|POST /api/payment/sabpaisa/callback
      │                         verifyCallback(): ok = TRUE, HARDCODED ⚠
      │                         trusts body.status
      │                         forwardToKkchat(data)  ──► kkchat.in ⚠
      │                         302 → /order/:id?status=...
      │
      └── server-to-server ─► POST /api/payment/sabpaisa/webhook
                                X-SabPaisa-Signature HMAC + 5-min replay window
                                (⚠ SKIPPED — WEBHOOK_SECRET not set)
                                idempotency_key dedupe (in-memory)
                                forwardToKkchat(body) ──► kkchat.in ⚠
                                order.status = paid | failed
                                200 {received:true}

              ┌────── Standalone forwarder (server.js:49-50) ──────┐
  SabPaisa ─► POST /callback/cpm/sapa/collection
                 log → blind-forward to kkchat.in
                 NO verification, NO order update
                 200 {status:"received"}
```

---

## 11. Current Order / Transaction System

**Orders exist. Nothing is persisted.**

`backend/routes/orders.js:6`:

```js
// In-memory order store. Replace with a real DB (Postgres/Mongo) in production.
export const orders = new Map();
```

The comment states the intent plainly: this is a placeholder. The `Map` is module-scoped and imported directly by `routes/payment.js:2`, so route modules share one process-local object.

**Order record shape (`orders.js:25-32`, extended by payment handlers):**

| Field | Source | Notes |
|---|---|---|
| `id` | `orders.js:26` | `FIR-${nanoid(10)}` — serves as `merchantTxnId` / `orderid` at both gateways |
| `items[]` | `:21` | `{id, title, price, qty}` — price snapshotted from the trusted catalog |
| `total` | `:23` | Server-computed `Σ price × qty`, in rupees |
| `buyer` | `:12, :29` | `{firstName, lastName, email, phone}` — **stored with zero validation** |
| `status` | `:30` | `"pending"` → `"paid"` \| `"failed"` |
| `createdAt` | `:31` | ISO string |
| `paidAt` | `payment.js:66, 126, 189` | ISO string, set on success |
| `apTransactionId` | `payment.js:67` | AirPay txn id |
| `spTransactionId` | `payment.js:127, 190` | SabPaisa txn id |
| `paidAmount` | `payment.js:191` | Webhook only — **never compared to `total`** |
| `simulated` | `payment.js:79, 146` | Set by the unauthenticated simulate endpoints |

**Against the Step 7 required-field checklist:**

| Field | Can it be stored today? |
|---|---|
| `orderId` | ✅ `order.id` |
| `productId` | ✅ `items[].id` |
| `amount` | ✅ `order.total` |
| `customerName` | ✅ `buyer.firstName` / `lastName` |
| `customerEmail` | ✅ `buyer.email` |
| `customerPhone` | ✅ `buyer.phone` |
| `gatewayTransactionId` | ⚠️ Yes but **split across two differently-named fields** (`apTransactionId`, `spTransactionId`) — no unified field, and no `gateway` discriminator. A third gateway makes this worse. |
| `paymentStatus` | ✅ `order.status` |
| `createdAt` | ✅ |
| `updatedAt` | ❌ **Absent.** Only `paidAt` exists. |
| `gatewayResponse` | ❌ **Not stored.** Raw payloads are `console.log`ed and returned in `verify*()` as `raw`, then discarded. |

**Not stored at all:** payments/transactions as first-class records (payment state is squashed into the order), customers (no table, no dedupe, no history), refunds (**no refund code anywhere**), and contact-form submissions — `routes/contact.js:12` validates and then only `console.log`s, with a `TODO` at `:11`. Every contact enquiry is lost.

**Consequence.** Because `nanoid` ids are random per-process and the store is memory-only, a restart loses all orders. A customer who pays during a deploy hits `payment.js:129` — `"order not in memory: ... — payment still valid"` — the code logs the loss and redirects to success anyway, with **no durable record that money changed hands**. This is the single biggest blocker to taking real payments. **CRITICAL** (§15).

---

## 12. Database Architecture

**No database exists.** This is verified, not inferred:

- No DB driver or ORM in either `package.json` (no `pg`, `mysql2`, `mongodb`, `mongoose`, `prisma`, `drizzle`, `sequelize`, `knex`, `sqlite3`, `@supabase/*`, `firebase`, `redis`).
- No `DATABASE_URL`, `MONGO_URI`, or equivalent in `.env` or `.env.example`.
- No `migrations/`, `models/`, `schema.prisma`, `database/`, or `repositories/` directory.
- No `.sql`, `.sqlite`, or `.db` file.

**All state is process memory, and all of it is volatile:**

| Store | Location | Contents | Lifetime |
|---|---|---|---|
| `orders` | `routes/orders.js:6` | All orders incl. paid | Until process exit |
| `processedWebhooks` | `routes/payment.js:152` | Webhook idempotency keys | Until process exit |
| Product catalog | `data/products.js` | 11 products | Static in source (deploy-time) |
| Cart | browser `localStorage` | `firvanra_cart` | Per-browser, client-trusted |

No tables, no collections, no schemas, no migrations, no relationships. The implicit relational model that **would** need expressing is: `Order 1—N OrderItem N—1 Product`, `Order 1—N Payment`, `Customer 1—N Order`.

Two further consequences for payment correctness:

- **Idempotency is as volatile as the orders.** A restart empties `processedWebhooks`, so a redelivered webhook is reprocessed as new. Idempotency keys must share the orders' durability.
- **Horizontal scaling is impossible.** Two instances behind a load balancer do not share the `Map`: an order created on instance A is invisible to a callback that lands on instance B. The app is **single-instance-only** until a real store exists. HIGH (§15).

---

## 13. Environment Configuration

Variable **names only** below. No values are reproduced, and none were printed during this audit.

**`backend/.env`** — present, **17 variables, 16 with non-empty values**:

```text
PORT
FRONTEND_URL
PUBLIC_BASE_URL
AIRPAY_MERCHANT_ID
AIRPAY_CLIENT_ID
AIRPAY_CLIENT_SECRET          ← secret, populated
AIRPAY_USERNAME               ← credential, populated
AIRPAY_PASSWORD               ← credential, populated
AIRPAY_SECRET                 ← secret, populated
AIRPAY_ENCRYPTION_KEY         ← empty (intentional: auto-derived, airpay.js:46)
AIRPAY_INSECURE_TLS           ← populated  ⚠ see below
AIRPAY_OAUTH_URL
AIRPAY_PAY_URL
SABPAISA_CLIENT_CODE
SABPAISA_API_KEY              ← secret, populated
SABPAISA_SECRET_KEY           ← secret, populated
SABPAISA_PAY_URL
```

**`backend/.env.example`** — 12 variables, **AirPay only**:

```text
PORT  FRONTEND_URL  PUBLIC_BASE_URL
AIRPAY_MERCHANT_ID  AIRPAY_CLIENT_ID  AIRPAY_CLIENT_SECRET
AIRPAY_USERNAME  AIRPAY_PASSWORD  AIRPAY_SECRET
AIRPAY_ENCRYPTION_KEY  AIRPAY_OAUTH_URL  AIRPAY_PAY_URL
```

**`frontend/`** — **no `.env`, no `.env.example`, no `.env.production`**, and no `import.meta.env` usage. Nothing is configurable at build time (§9).

### Findings

**1. CRITICAL SECURITY ISSUE — populated credentials committed in `backend/.env`.**

```text
CRITICAL SECURITY ISSUE
```

`backend/.env` contains non-empty values for six secrets — `AIRPAY_CLIENT_SECRET`, `AIRPAY_USERNAME`, `AIRPAY_PASSWORD`, `AIRPAY_SECRET`, `SABPAISA_API_KEY`, `SABPAISA_SECRET_KEY` — sitting in the project tree with **no `.gitignore` in `backend/`, `frontend/`, or the workspace root**. The values are **not** printed here. The lengths and the live production URLs in the code (`firvanra.online`, `merchant-api.sabpaisa.in`) are consistent with **real merchant credentials, not placeholders**. In AirPay's scheme these are not merely API keys: `AIRPAY_USERNAME` + `AIRPAY_PASSWORD` **derive the AES encryption key** (`airpay.js:47`) and, with `AIRPAY_SECRET`, the `privatekey` (`:80-85`) — so disclosure permits forging valid transaction payloads *and* decrypting captured ones. `SABPAISA_SECRET_KEY` likewise allows forging initiation checksums.

Required: treat all six as compromised and **rotate them**; add `.gitignore` entries for `.env*` (keeping `!.env.example`) before any `git init`; move production values into the host's secret manager. Also note `backend/.env` is **not** a committed-history problem today (the workspace is not a git repository, verified) — which is precisely why this must be fixed *before* initializing one.

**2. HIGH — `AIRPAY_INSECURE_TLS` is set.** `airpay.js:21-24` builds an `https.Agent({rejectUnauthorized:false})` when this is `"true"`, disabling certificate verification for all AirPay calls — including the OAuth2 exchange that carries encrypted credentials. The code's own comment says *"DEMO-ONLY ... REMOVE for production"* (`:18-20`). It is currently populated with a 4-character value, consistent with `true`. This makes the credential exchange MITM-able.

**3. MEDIUM — `.env.example` is stale and incomplete.** All four `SABPAISA_*` variables are missing, as is `AIRPAY_INSECURE_TLS`. Most consequentially, **`SABPAISA_WEBHOOK_SECRET` appears in neither file** although `sabpaisa.js:12` reads it and `:75` silently disables signature verification when it is blank. A developer following `.env.example` would deploy with webhook verification off and no warning.

---

## 14. Deployment Architecture

**No deployment configuration exists in either application.** Verified absent: `vercel.json`, `netlify.toml`, `Dockerfile`, `docker-compose.yml`, `Procfile`, `render.yaml`, `railway.json`, `app.yaml`, `nginx.conf`, `ecosystem.config.js` (pm2), `.github/workflows/`, and any other CI definition. Neither folder is a git repository, and there is no `.gitignore`.

Everything below is therefore **inferred from URLs and comments in the source**, not verified configuration.

**Evidence of an intended production target:**

- `routes/payment.js:155` — *"Provide this URL to SabPaisa support: `https://firvanra.online/api/payment/sabpaisa/webhook`"*. This implies the backend is reachable at `firvanra.online/api/*` — i.e. **frontend and backend share one origin**, with `/api` reverse-proxied to Node. That matches `api.js:1`'s relative `/api` base, which only works same-origin (§9).
- `.env.example:3-5` — `PUBLIC_BASE_URL` is documented as *"Public URL of THIS backend (needed so AirPay can reach the callback) ... Locally, use an ngrok https URL"*. It is used to build the SabPaisa `returnUrl` (`sabpaisa.js:38`). Note AirPay's callback URL is **not** built from it — it is presumably configured in the AirPay merchant dashboard (**UNVERIFIED**, external).
- `FRONTEND_URL` drives both CORS (`server.js:11`) and post-payment redirect targets (`payment.js:16`).
- Default ports: frontend `5173` (Vite), backend `4000`.

**Inferred production architecture (same-origin reverse proxy):**

```text
                    Browser
                       │  HTTPS (required — gateway callbacks and
                       │  payment data must not traverse plain HTTP)
                       ▼
          ┌────────────────────────────┐
          │  https://firvanra.online   │
          │  Reverse proxy (nginx?)    │   ← NOT in repo; UNVERIFIED
          └────────────┬───────────────┘
                 ┌─────┴─────┐
         /       │           │  /api/*  ,  /callback/cpm/sapa/collection
                 ▼           ▼
   Static SPA (vite build  Node/Express  server.js  :4000
   → dist/, any static     single instance ONLY (in-memory Map, §12)
   host)                        │
                                ├──► AirPay    kraken/payments.airpay.co.in
                                ├──► SabPaisa  merchant-api.sabpaisa.in
                                └──► kkchat.in /callback/cpm/sapa/collection  ⚠ §15
                                │
                                ▼
                    ╔═══════════════════════╗
                    ║  DATABASE: NONE       ║
                    ║  state = process RAM  ║
                    ╚═══════════════════════╝
```

**Is frontend/backend deployment configuration separate? Neither — there is none at all.** The two apps are separately *buildable* (independent `package.json`, independent lockfiles, no shared workspace file, no root `package.json`) but the code assumes they are *served together*. If they are in fact deployed split-host (e.g. Vercel + Render), `api.js:1` must change — flagged HIGH in §15.

**Missing for production regardless of host:** process supervision (pm2/systemd/container restart), the reverse-proxy config itself, a TLS strategy, `engines: {node: ">=18"}` (§6), structured logging and log shipping (today: `console.log` only), health-check wiring (`/api/health` exists, nothing monitors it), and any CI/CD.

---

## 15. Security Findings

Severity reflects impact on **taking real money**. Line references are to the current files.

| Severity | Finding | File | Risk | Recommendation |
|---|---|---|---|---|
| **CRITICAL** | Populated merchant credentials committed in `.env`; no `.gitignore` anywhere | `backend/.env`; absent `.gitignore` | Six live secrets in the tree. AirPay username+password derive the AES key and privatekey → attacker can forge *and* decrypt transaction payloads; `SABPAISA_SECRET_KEY` forges checksums. One `git init && git push` publishes them permanently | Rotate all six now. Add `.gitignore` (`.env*`, `!.env.example`) **before** initializing git. Move values to the host secret manager. Never commit populated `.env` |
| **CRITICAL** | Unauthenticated payment-simulation endpoints live in all environments | `routes/payment.js:74-81`, `:141-148` | `POST /api/payment/airpay/simulate/:orderId` sets any order to `paid` with no auth, no env guard. Anyone who learns an order id gets goods for free | Delete, or hard-gate behind `NODE_ENV !== "production"` **and** a shared secret. Never ship a route that can mark an order paid |
| **CRITICAL** | SabPaisa webhook signature verification silently disabled | `services/sabpaisa.js:75`; `routes/payment.js:160` | `verifyWebhookSignature` returns `{ok:true, skipped:true}` when `SABPAISA_WEBHOOK_SECRET` is unset — and it is **absent from `.env` and `.env.example`**. Any unauthenticated POST can mark orders paid. The HMAC code is correct but never runs | Set the secret and **fail closed**: treat a missing secret as a startup error, or reject with 400. Add it to `.env.example` |
| **CRITICAL** | SabPaisa redirect-callback verification hardcoded to pass | `services/sabpaisa.js:115`; `routes/payment.js:123` | `const ok = true; // Accept all SabPaisa callbacks`. Checksum is computed and logged but not enforced; the route branches on `result.paid` and ignores `ok`. A crafted GET with `?merchant_txn_id=FIR-x&status=SUCCESS` marks an order paid | Enforce the checksum; reject on mismatch. Resolve the amount-unit question (`:111` comment) with SabPaisa rather than disabling the check. Make `payment.js:123` require `result.ok && result.paid` |
| **CRITICAL** | AirPay callback passes verification when the hash is absent | `services/airpay.js:167` | `const hashOk = !received \|\| computed === String(received)` — omitting `ap_SecureHash` bypasses CRC32 entirely, allowing forged success callbacks | Require the hash: `Boolean(received) && computed === String(received)`. Reject otherwise |
| **CRITICAL** | No durable persistence — paid orders lost on restart | `routes/orders.js:6`; `routes/payment.js:152` | Orders and webhook idempotency keys live in process memory. A restart/crash/deploy destroys the record of completed payments; `payment.js:129` logs *"order not in memory ... payment still valid"* and redirects to success anyway. Money taken with no record = unfulfillable orders, disputes, no reconciliation | Add a real datastore (Postgres recommended) for orders, payments, and idempotency keys **before** going live |
| **HIGH** | TLS certificate verification disabled for gateway calls | `services/airpay.js:18-24`; `AIRPAY_INSECURE_TLS` set in `.env` | `rejectUnauthorized:false` on all AirPay HTTPS, including the OAuth2 credential exchange → MITM can intercept/alter payment traffic. The code itself says *"DEMO-ONLY ... REMOVE for production"* | Remove the flag and the `insecureAgent` branch. If AirPay's certificate is genuinely expired, escalate to AirPay |
| **HIGH** | Full payment payloads forwarded to an unexplained third-party domain | `server.js:28-50`; `routes/payment.js:17-31, 119, 179` | Callback and webhook bodies (txn ids, amounts, customer data) are POSTed to `https://kkchat.in/callback/cpm/sapa/collection`, fire-and-forget, unauthenticated, with no verification at `server.js:50`. Nothing in the repo explains why. Potential PII/payment-data leak and a possible DPDP-Act concern | **Confirm with the project owner whether this is intentional.** If not, remove. If yes: document it, authenticate it, verify signatures *before* forwarding, and forward the minimum necessary fields |
| **HIGH** | No authentication or authorization on any endpoint | all of `backend/routes/` | Every route is public, including `GET /api/orders/:id` (exposes buyer name, email, phone, order contents to anyone with an id) and the simulate routes. No login exists anywhere | Add auth before any account features. Minimum now: make order lookup require an unguessable token, not just the id |
| **HIGH** | No rate limiting anywhere | `server.js` | Order creation, payment initiation, contact form, and order lookup are all unthrottled → order-id enumeration, gateway-quota exhaustion, contact-form spam, trivial DoS | Add `express-rate-limit`, tightest on `/api/payment/*` and `/api/contact` |
| **HIGH** | Paid amount never validated against the order total | `routes/payment.js:64-68, 123-131, 187-191`; `airpay.js:158` | Callbacks/webhooks mark orders `paid` on status alone. `paidAmount` is stored (`:191`) but never compared to `order.total`. A partial or manipulated amount still completes the order | On every success path assert `receivedAmount === expectedAmount` (unit-normalized); on mismatch flag for manual review, do not mark paid |
| **HIGH** | Hardcoded relative API base breaks split-host deployment | `frontend/src/api.js:1`; `frontend/vite.config.js:8` | `base = "/api"` works only via the Vite dev proxy or same-origin production. No `VITE_*` var exists, so the backend URL cannot be configured at build time → every API call 404s under split-host hosting | Introduce `VITE_API_BASE_URL` with a same-origin default; add `frontend/.env.example`. Enable CORS credentials only if cookies are later adopted |
| **HIGH** | In-memory state prevents horizontal scaling | `routes/orders.js:6`; `routes/payment.js:152` | Two instances do not share the `Map` → a callback landing on instance B cannot find an order created on instance A, producing random payment failures under any load-balanced or auto-scaling deploy | Single instance only until a shared datastore exists; document this constraint explicitly |
| **MEDIUM** | No input validation on buyer data | `routes/orders.js:12, 29`; `routes/contact.js:8` | Presence-only checks. `buyer` is stored verbatim with no email/phone format validation, no length caps, no sanitization → bad data reaches the gateway (which may reject it), and unbounded strings enable memory abuse | Validate with Zod/Joi at the route boundary: email format, E.164-ish phone, length limits, strip unknown keys |
| **MEDIUM** | Gateway amount units differ between the two integrations | `airpay.js:129` (rupees, `toFixed(2)`) vs `sabpaisa.js:26` (paise, `×100`) | A third gateway copying the wrong pattern produces a 100× under- or over-charge. There is no shared money type and no tests | Store a single canonical unit (recommend integer paise) and convert **once**, per-gateway, in the adapter. Add unit tests |
| **MEDIUM** | No global error handler; error details leak to clients | `server.js` (none); `routes/payment.js:54, 104` | No Express error middleware → unhandled throws emit default HTML stack traces in non-production. Worse, `payment.js:104` returns `JSON.stringify(err.response?.data)` — raw gateway responses — straight to the client, and `sabpaisa.js:53-54` logs full payloads | Add a terminating error handler that logs internally and returns a generic message + correlation id. Never return raw gateway bodies |
| **MEDIUM** | Cart cleared before the user reaches the gateway | `frontend/src/pages/Checkout.jsx:50` | `clear()` runs before `f.submit()`. Abandoning or failing payment leaves the user with an empty cart and a stranded `pending` order, with no retry path | Clear only after confirmed success (on `/order/:id` when `status === "paid"`) |
| **MEDIUM** | Secrets logged; verbose payment logging | `sabpaisa.js:43, 57, 112`; `payment.js:112` | `console.log("[sabpaisa initiate] sending:", JSON.stringify(payload))` logs the full checksum and customer PII; `:112` logs computed/received checksums; `payment.js:112` logs raw callback data. Anyone with log access gains verification material and PII | Redact checksums/PII; use levelled logging and disable debug payloads in production |
| **MEDIUM** | No order-expiry or state-machine guard | `routes/orders.js`, `routes/payment.js` | Orders stay `pending` forever; a `failed` order can later be set `paid` by a late callback (`payment.js:124-127` does not check current status). Only `initiate` guards `status === "paid"` (`:39, :89`) | Add explicit state transitions (`pending → paid\|failed\|expired`), reject invalid transitions, expire stale pending orders |
| **MEDIUM** | Hidden test product exposed via the public catalog | `data/products.js:100-101`; `routes/products.js:8` | The ₹10 `sabpaisa-test-10` product is returned by unfiltered `GET /api/products` despite the "never shown in product listings" comment. It is also orderable via `POST /api/orders`. Hidden only incidentally, by a frontend `type` filter | Exclude `type === "test"` server-side, or gate it behind an env flag |
| **LOW** | AirPay callback field casing unconfirmed | `airpay.js:148-149` | The code reads both v4 and legacy names with a comment that casing must be confirmed against a real sandbox callback. **UNVERIFIED** in-repo | Confirm against an actual AirPay sandbox callback and remove the dead branch |
| **LOW** | `/payment-test` route referenced but missing | `data/products.js:101`; `frontend/src/main.jsx:14-18` | The documented gateway-test harness does not exist; the comment misleads | Build the page or correct the comment |
| **LOW** | No `engines` field though Node ≥18 is required | `backend/package.json` | Global `fetch` (`server.js:36`) and `node --watch` need ≥18 / ≥18.11. An older host fails at runtime, not install | Add `"engines": {"node": ">=18.17"}` |
| **LOW** | Broken product images; dead nav anchor; empty stray directory | `data/products.js` `image` fields (no `public/`); `Header.jsx:16` (`#about`); `backend/{routes,services,data}/` | Cosmetic/housekeeping only | Add `public/img/**`, fix or remove the anchor, delete the stray directory |
| **LOW** | No tests and no CI | both `package.json` | Zero tests for crypto, checksums, or amount math — the highest-risk code in the repo. No CI to catch regressions | Add unit tests for checksum/encrypt/verify and amount conversion; add a CI workflow |

### The amount-authority question (Step 10's central concern) — **PASS**

**The frontend is correctly NOT authoritative for the payment amount.** Verified:

- `Checkout.jsx:25-28` sends only `items.map(i => ({id: i.id, qty: i.qty}))` plus `buyer`. **No price and no total is transmitted.**
- `routes/orders.js:17-23` ignores any client pricing, calls `getProduct(id)` per line, rejects unknown ids (`:19`), clamps `qty` to `≥1` (`:20`), and computes `total` from catalog prices (`:23`).
- `payment.js:36-37, 86-87` accept only `orderId`; the amount is read from the server-stored order and is never client-supplied (`airpay.js:129`, `sabpaisa.js:26`).

A client POSTing `{"amount": 1}` to either initiate endpoint is ignored — the field is not read. The attack in the brief **does not work here**, and the `productId → trusted price` model the brief recommends is already the implemented design. Preserve it exactly when adding the new gateway.

Two caveats that keep this from being fully airtight: the **inbound** direction is unverified (no amount check on callbacks/webhooks — HIGH above), and cart `price`/`title` fields do round-trip through `localStorage` into the UI, so a tampered localStorage changes *displayed* prices (not charged ones). Cosmetic, but it can produce a confusing price mismatch at the gateway.

---

## 16. Payment Gateway Integration Points

Real paths from this repository. A new gateway touches these files — most of the structure already exists.

**Backend — new files to add:**

```text
backend/services/<newgateway>.js      NEW — mirror services/sabpaisa.js (the better model):
                                      cfg from process.env, <gw>Configured(),
                                      checksum/signature helpers, initiatePayment(order, buyer),
                                      verifyCallback(body), verifyWebhookSignature(header, rawBody)
```

**Backend — existing files to modify:**

```text
backend/routes/payment.js             Add the /<newgateway>/{initiate,callback,webhook} block.
                                      Currently 199 lines of per-gateway duplication
                                      (AirPay :33-81, SabPaisa :83-197) — the natural
                                      refactor point for a provider registry.
backend/routes/orders.js              Order shape: add `gateway`, unified
                                      `gatewayTransactionId`, `updatedAt`, `gatewayResponse`;
                                      replace the in-memory Map (:6) with a real store.
backend/server.js                     Only if a non-/api callback path is required
                                      (see the existing :49-50 precedent).
                                      req.rawBody capture (:14-16) ALREADY supports
                                      HMAC webhooks — reuse it, do not re-add it.
backend/data/products.js              Trusted price source — getProduct(id) (:103) is
                                      already the correct price authority. Leave the
                                      model intact.
backend/.env  /  .env.example         New <GW>_* variable names (example file only).
```

**Frontend — existing files to modify:**

```text
frontend/src/api.js                   :21-24 — the gateway-specific calls live here.
                                      Generalize to initiatePayment(orderId, gateway).
frontend/src/pages/Checkout.jsx       :29-51 — the payment hand-off. Two branches exist
                                      (simulated :31-36, auto-submit form :38-51);
                                      a redirect-URL gateway needs a third:
                                      window.location.href = checkoutUrl.
                                      Also fix clear() ordering (:50) and the
                                      hardcoded "with AirPay" label (:86, :89).
frontend/src/pages/OrderStatus.jsx    Success/failure screen — already generic over
                                      gateways; likely no change needed.
frontend/src/main.jsx                 :14-18 — add /payment-test if the test harness
                                      is to be (re)built.
```

**New frontend files (optional, recommended):**

```text
frontend/src/pages/PaymentTest.jsx    The missing /payment-test harness
                                      (data/products.js:101 already expects it)
frontend/.env.example                 VITE_API_BASE_URL — does not exist today (§9)
```

**Do NOT reuse as a template:** `server.js:28-50` (the unverified kkchat forwarder) and either `simulate` route.

---

## 17. Recommended Future Payment Architecture

The brief's proposed flow is **already how this codebase works** for AirPay. The recommendation is therefore not a redesign but a **generalization plus the two missing foundations** (durable storage, enforced verification).

```text
                    Product  (backend/data/products.js — TRUSTED PRICE SOURCE)
                       ↓
                    Buy Now / Add to cart   (Services.jsx, EbookShop.jsx)
                       ↓
    Frontend sends ONLY { items:[{id, qty}], buyer }      ← ALREADY CORRECT, PRESERVE
                       ↓
    Backend resolves trusted price via getProduct(id)     ← ALREADY CORRECT, PRESERVE
                       ↓
    Backend creates internal order                        ← EXISTS, but memory-only
       └─► PERSIST to database: order + line items + status="pending"   ← ADD
                       ↓
    Backend calls payment gateway via a provider adapter  ← EXISTS per-gateway;
       providers = { airpay, sabpaisa, <new> }               ADD the registry
       each exposing: configured(), initiate(), verifyCallback(), verifyWebhook()
                       ↓
    Gateway checkout  (auto-submit form OR redirect to checkoutUrl — support both)
                       ↓
    Customer pays
                       ↓
    ┌──────────────────┴───────────────────┐
    │ Callback (browser)      Webhook (S2S) │
    │  — UX only              — SOURCE OF   │
    │  — never trust alone       TRUTH      │
    └──────────────────┬───────────────────┘
                       ↓
    Backend verifies:   signature/checksum  ENFORCED, fail closed   ← FIX (§15)
                        amount == order.total (unit-normalized)      ← ADD
                        state transition is legal (pending → paid)   ← ADD
                        idempotency key not already seen (persisted) ← MAKE DURABLE
                       ↓
    Order updated   status, paidAt, updatedAt, gateway,
                    gatewayTransactionId, paidAmount, gatewayResponse
                       ↓
    Success / Failed screen   (OrderStatus.jsx — EXISTS, polls GET /api/orders/:id)
```

**Compatibility with the existing repository: high.** Every stage has a real home in the current code, and the two most error-prone pieces — server-side pricing and raw-body HMAC verification — are already built correctly. Specific recommendations:

1. **Introduce a provider interface, don't add a third copy.** `routes/payment.js` already duplicates a full route block per gateway. Define `services/providers/<name>.js` all exporting the same five functions, register them in a map, and collapse the routes to `/api/payment/:provider/{initiate,callback,webhook}` with a lookup. This is the one refactor worth doing *before* the new gateway, because it prevents a third divergence.
2. **Treat the webhook as the source of truth and the browser callback as UX only.** The SabPaisa webhook path already models this well (idempotency, replay window, timing-safe compare) — promote it to the shared pattern.
3. **Canonicalize money as integer paise** in the order record, converting once inside each adapter. This directly removes the rupees-vs-paise divergence (§15 MEDIUM).
4. **Persist orders, payments, and idempotency keys** in Postgres (see §18). Everything else is secondary to this.
5. **Keep the simulated path, but gate it** behind `NODE_ENV !== "production"` — it is genuinely useful for credential-less development, just not publicly reachable.

**On the Step 6 question — is a lightweight JS/JSON catalog compatible?** Yes, and it is already the architecture. `backend/data/products.js` + `getProduct(id)` is exactly the recommended model, and critically it sits **on the backend**, so it is already the trusted price authority. Recommendations: (a) **keep the catalog server-side** — do not move it to the frontend, which would forfeit the trust boundary that is currently the system's main strength; (b) the frontend needs no local catalog, since `GET /api/products` already serves it; (c) **a product database is not necessary** for 11 static products with no inventory, variants, or admin editing — a code-deployed catalog is appropriate and simpler; (d) an **orders/payments database is necessary regardless** (§12) — that is a separate concern from product management, and the two decisions should not be conflated.

---

## 18. Missing Components

### Required (blocking real payments)

- **Durable persistence** for orders, payments, and webhook idempotency keys — replacing `orders.js:6` and `payment.js:152`.
- **Credential rotation + `.gitignore`** for the six populated secrets in `backend/.env` (§13).
- **Removal or hard-gating of both `simulate` endpoints** (`payment.js:74, 141`).
- **Enforced signature/checksum verification**: set `SABPAISA_WEBHOOK_SECRET` and fail closed (`sabpaisa.js:75`); remove the hardcoded `ok = true` (`:115`); require the AirPay hash (`airpay.js:167`).
- **Amount validation on all inbound callbacks/webhooks** against the stored order total.
- **Removal of `AIRPAY_INSECURE_TLS` / `insecureAgent`** (`airpay.js:18-24`).
- **Resolution of the `kkchat.in` forwarding question** — confirm intent, then document+secure or remove.
- **Input validation** (Zod/Joi) on `POST /api/orders` and `POST /api/contact`.
- **The new gateway's own** service adapter, routes, env variables, and frontend hand-off branch.
- **`VITE_API_BASE_URL`** (or a confirmed same-origin reverse proxy) so the SPA can reach the API in production (§9).
- **Deployment configuration** — none exists (§14): process supervision, reverse proxy, TLS.

### Recommended (strongly advised before launch)

- Provider-registry refactor of `routes/payment.js` (§17.1).
- Global Express error handler; stop returning raw gateway bodies (`payment.js:104`).
- Rate limiting (`express-rate-limit`) and security headers (`helmet`).
- Canonical integer-paise money handling with unit tests.
- Order state machine + stale-pending expiry.
- Unified `gateway` + `gatewayTransactionId` + `updatedAt` + `gatewayResponse` fields.
- Structured, redacted logging (pino/winston) replacing `console.log`; stop logging checksums and PII.
- Persist contact-form submissions (`contact.js:11` `TODO`) — currently every enquiry is lost.
- Unit tests for checksum/encrypt/verify and amount conversion; CI.
- Update `.env.example` with all `SABPAISA_*` vars and `SABPAISA_WEBHOOK_SECRET`.
- Fix `clear()` ordering in `Checkout.jsx:50`.
- Exclude `type === "test"` products server-side.
- Add `engines: {node: ">=18.17"}`.
- Reconciliation view/report for payments vs orders.

### Optional (nice to have)

- `/payment-test` harness page (`data/products.js:101` already references it).
- Order-confirmation email / receipt (no mailer installed).
- Ebook digital delivery — ebooks are sold with **no fulfilment mechanism anywhere**.
- Customer accounts + order history (requires the auth that does not exist).
- Refunds (no refund code in the repo).
- Admin dashboard for orders.
- Product images under `frontend/public/img/**`; render `<img>` in `EbookShop.jsx:19`.
- `#about` section or anchor removal (`Header.jsx:16`).
- TypeScript migration; shared types between apps.
- Delete the empty `backend/{routes,services,data}/` directory.
- Multi-gateway selection UI, if more than one gateway is to stay live.

---

## 19. Payment Integration Readiness

```text
MOSTLY READY
```

**Why MOSTLY READY rather than READY.** The hard parts of a payment integration are already built and working. The product→cart→order→gateway→callback→status loop is complete end-to-end; two real gateways are implemented including OAuth2, AES-256-CBC, SHA-256/HMAC checksums, CRC32 verification, raw-body-exact webhook signing, replay windows, timing-safe comparison, and idempotency. Most importantly, **the trust model is already right**: the frontend transmits only `{id, qty}` and the backend prices every order from its own catalog, so the amount-tampering attack the brief centers on does not work. Adding a third gateway is a well-understood, low-risk change against this structure — probably a day's work for the happy path.

**Why not READY.** Two foundations are missing, and neither is about the gateway:

1. **No durable storage.** Orders live in a process-memory `Map`. Taking real money against this means a restart erases the record of completed payments — the code even logs *"order not in memory ... payment still valid"* and redirects to success regardless (`payment.js:129`). Webhook idempotency keys are equally volatile, so redelivered webhooks reprocess after any restart. This also pins the app to a single instance.
2. **Verification is implemented but switched off, and secrets are exposed.** Three independent bypasses exist: `SABPAISA_WEBHOOK_SECRET` is unset so webhook HMAC checking is skipped (`sabpaisa.js:75`); `verifyCallback` hardcodes `ok = true` (`:115`); the AirPay hash check passes when the hash is simply absent (`airpay.js:167`). Separately, two unauthenticated `simulate` endpoints will mark any order paid, TLS verification is disabled for AirPay, and six populated merchant credentials sit in an un-gitignored `.env`.

**Why not PARTIALLY READY.** None of the above requires new architecture — the correct code largely exists and needs enabling, plus one datastore. The design is sound; the configuration and persistence are not.

**Net:** the project is ready for the **integration work**, not for **production traffic**. Build the new gateway against the existing structure, but treat the §18 *Required* list as a hard gate before the first real rupee moves.

---

## 20. Recommended Implementation Order

Adapted to this repository. Phases 0–2 are the gate; the new gateway itself does not begin until Phase 3.

**Phase 0 — Secrets & safety (do first, before writing any code)**
1. Rotate all six populated secrets in `backend/.env` (AirPay client-secret/username/password/secret, SabPaisa api-key/secret-key).
2. Add `.gitignore` (`.env*`, `!.env.example`, `node_modules`, `dist`) to both apps **before** any `git init`.
3. Remove `AIRPAY_INSECURE_TLS` and the `insecureAgent` branch (`airpay.js:18-24`).
4. Delete or hard-gate both `simulate` routes (`payment.js:74, 141`).
5. **Confirm the `kkchat.in` forwarding intent** with the project owner; remove or document+secure it.

**Phase 1 — Persistence (the real blocker)**
6. Choose a datastore (Postgres recommended) and add `DATABASE_URL`.
7. Model `orders`, `order_items`, `payments`, `webhook_events` (idempotency keys) — including `gateway`, `gatewayTransactionId`, `updatedAt`, `gatewayResponse`.
8. Replace the `orders` Map (`orders.js:6`) and `processedWebhooks` Set (`payment.js:152`) with repository calls, leaving the route contracts unchanged.

**Phase 2 — Fix existing verification (before adding a third gateway)**
9. Require the AirPay hash (`airpay.js:167`); enforce the SabPaisa callback checksum (`sabpaisa.js:115`) and wire `result.ok` into `payment.js:123`.
10. Set `SABPAISA_WEBHOOK_SECRET`, make a missing secret a startup failure (`sabpaisa.js:75`), and add it to `.env.example`.
11. Add amount validation on every success path; canonicalize money as integer paise.
12. Add an order state machine (`pending → paid|failed|expired`) rejecting illegal transitions.

**Phase 3 — Provider abstraction**
13. Extract `services/providers/{airpay,sabpaisa}.js` behind one interface (`configured`, `initiate`, `verifyCallback`, `verifyWebhook`) and collapse `routes/payment.js` to `/api/payment/:provider/*` via a registry. Decide here whether AirPay or SabPaisa is being retired (§9, UNVERIFIED).

**Phase 4 — New gateway: creation**
14. Write `services/providers/<new>.js` and its `<GW>_*` env names (add to `.env.example`).
15. Wire `POST /api/payment/<new>/initiate` through the registry; verify order lookup, trusted amount, and checksum against sandbox.

**Phase 5 — Checkout redirect**
16. Generalize `api.js:21` to `initiatePayment(orderId, gateway)`; add the redirect-URL branch to `Checkout.jsx:29-51`; de-hardcode the "with AirPay" labels (`:86, :89`); move `clear()` to post-success.

**Phase 6 — Callback & webhook**
17. Implement `/<new>/callback` (browser UX) and `/<new>/webhook` (source of truth), reusing `req.rawBody` (`server.js:15`) and the persisted idempotency store. Register the webhook URL with the provider.

**Phase 7 — Verification hardening**
18. Signature enforcement failing closed, amount match, replay window, timing-safe compare, duplicate handling — the SabPaisa webhook (`payment.js:156-197`) is the reference implementation.

**Phase 8 — Success / failure UI**
19. Extend `OrderStatus.jsx` for the new gateway's statuses; add pending-state polling for async methods (UPI/netbanking can settle after redirect).
20. Optionally build the missing `/payment-test` page (`data/products.js:101`).

**Phase 9 — Security hardening**
21. `helmet`, `express-rate-limit` (tightest on `/api/payment/*`, `/api/contact`), Zod validation on `POST /api/orders` + `/api/contact`, global error handler that stops leaking gateway bodies (`payment.js:104`), redacted structured logging, server-side exclusion of `type === "test"`, and an unguessable token for `GET /api/orders/:id`.

**Phase 10 — Testing**
22. Unit tests for checksum/encrypt/verify and paise conversion; integration tests for the full order→pay→webhook→status loop; replayed-webhook and forged-callback tests; sandbox end-to-end for every live gateway. (There are currently **zero** tests.)

**Phase 11 — Production configuration**
23. Pick and commit a deployment topology (§14); set `FRONTEND_URL`, `PUBLIC_BASE_URL`, `VITE_API_BASE_URL`; reverse proxy + TLS; process supervision; `engines: {node: ">=18.17"}`; monitor `/api/health`; log shipping; a reconciliation report; and document the single-instance constraint until Phase 1 is proven under load.

---

### Appendix — Verification notes and open questions

**Method.** All 33 source files were read in full. Searches were run across both apps for product/cart/checkout/order/payment/transaction/callback/webhook/signature/checksum/merchant terminology, for payment SDK packages, for security middleware (`helmet`, rate-limit, JWT, Joi/Zod), and for hardcoded secret-shaped literals in source (**none found** — all secrets are read from `process.env`). No file was modified; nothing was installed or executed. No secret value was printed at any point.

**Open questions for the project owner — these materially affect the integration:**

1. **Which gateway does the new one replace — AirPay, SabPaisa, or neither?** SabPaisa is fully implemented but has no frontend caller, while AirPay is the live path. Unresolvable from the code.
2. **What is `kkchat.in`?** Eight references forward full payment payloads to it. Intentional relay or leftover debug code?
3. **Are the `.env` credentials real production credentials?** Length and the live URLs suggest yes; this determines rotation urgency.
4. **Same-origin or split-host deployment?** `payment.js:155` implies same-origin; this decides whether `api.js:1` must change.
5. **Where is the AirPay callback URL configured?** It is not built from `PUBLIC_BASE_URL`, so presumably in the AirPay dashboard — external and unverifiable here.
6. **Was `/payment-test` deleted or never built?**

**Explicitly UNVERIFIED (cannot be determined from the repository):** AirPay callback field-name casing (`airpay.js:148`); whether `/payment-test` ever existed; the real production hosting setup; whether any gateway has been successfully tested end-to-end; gateway dashboard configuration; and the actual contents of `node_modules` (dependency versions were read from `package.json`, not audited for vulnerabilities).
