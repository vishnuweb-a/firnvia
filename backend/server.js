import "dotenv/config";
import express from "express";
import cors from "cors";

import products from "./routes/products.js";
import orders from "./routes/orders.js";
import payment from "./routes/payment.js";
import contact from "./routes/contact.js";
import airpay2, {
  AIRPAY2_CALLBACK_PATH,
  airpay2Callback,
  airpay2CallbackMethodNotAllowed,
} from "./routes/airpay2.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));

// AirPay 2 Response URL + IPN URL. Registered BEFORE the global body parsers:
// the route reads the raw bytes itself so they can be relayed to KKChat as-is.
app.post(AIRPAY2_CALLBACK_PATH, ...airpay2Callback);
app.get(AIRPAY2_CALLBACK_PATH, airpay2CallbackMethodNotAllowed);

// Capture raw body for SabPaisa webhook signature verification before JSON parsing.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
// AirPay posts back as form-encoded:
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (_, res) => res.json({ ok: true, service: "firvanra-api" }));

// Which build is answering, so a deployment can be checked before a controlled
// payment. Vercel system variables only (sanitised); no configuration state.
const shown = (v, re) => (re.test(v || "") ? v : "unknown");
app.get("/api/health/version", (_, res) => res.json({
  ok: true,
  service: "firvanra-api",
  commit: shown((process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12), /^[0-9a-f]{7,12}$/),
  ref: shown(process.env.VERCEL_GIT_COMMIT_REF, /^[\w./-]{1,60}$/),
  environment: shown(process.env.VERCEL_ENV, /^(production|preview|development)$/),
  airpay2_callback_path: AIRPAY2_CALLBACK_PATH,
}));
app.use("/api/products", products);
app.use("/api/orders", orders);
app.use("/api/payment", payment);
app.use("/api/payment/airpay-2", airpay2);
app.use("/api/contact", contact);

// ── Legacy SabPaisa relay endpoint ───────────────────────────────────────────
// This endpoint previously accepted any unauthenticated POST and blind-forwarded
// the payload to https://kkchat.in/callback/cpm/sapa/collection. It performed no
// signature verification and updated no order, so the relay could be driven by
// anyone with the URL.
//
// UNVERIFIED BUSINESS INTEGRATION — OWNER CONFIRMATION REQUIRED. The forwarding
// is disabled rather than deleted, pending confirmation of what consumes it. The
// verified relay now lives in routes/payment.js, which forwards only payloads
// that passed SabPaisa signature/checksum verification.
//
// The verified S2S endpoint is POST /api/payment/sabpaisa/webhook.
function handleSapaCallback(req, res) {
  const timestamp = new Date().toISOString();
  console.warn("[sapa callback] unverified relay endpoint hit; not forwarded |",
    timestamp, "| ip:", req.ip);
  res.status(410).json({
    error: "Endpoint retired. Use POST /api/payment/sabpaisa/webhook.",
    timestamp,
  });
}

app.get("/callback/cpm/sapa/collection",  (_req, res) => res.json({ status: "active" }));
app.post("/callback/cpm/sapa/collection", handleSapaCallback);

// Vercel imports this module and handles the HTTP listener itself, so only bind
// a port when running as a standalone process (local dev, `npm start`, tests).
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

export default app;
