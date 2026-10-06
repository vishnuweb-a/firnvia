import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import App from "../App.jsx";
import Footer from "../components/Footer.jsx";
import { useCart } from "../context/CartContext.jsx";
import { api } from "../api.js";
import { isPaid, isSettled } from "../utils/payment.js";

const inr = (n) => `₹${n.toLocaleString("en-IN")}`;

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 60000;

const VIEW = {
  paid: {
    cls: "status-paid", icon: "✅", badge: "Payment successful",
    title: "Thank you for your order",
    note: null,
  },
  failed: {
    cls: "status-failed", icon: "⚠️", badge: "Payment failed",
    title: "Payment didn't go through",
    note: "No money has been captured for this attempt. Your cart is still saved, so you can try again.",
  },
  pending: {
    cls: "status-pending", icon: "⏳", badge: "Payment pending",
    title: "We're confirming your payment",
    note: "We're checking with the payment provider. This page updates on its own — it can take a few moments.",
  },
};

export default function OrderStatus() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { clear } = useCart();
  const [order, setOrder] = useState(null);
  const [err, setErr] = useState(null);
  const [timedOut, setTimedOut] = useState(false);
  const clearedRef = useRef(false);

  // Poll GET /api/orders/:id until the backend settles the order. Query
  // parameters from the gateway return are never consulted for status — only
  // this response decides. Bounded, and torn down on unmount.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const next = await api.getOrder(id);
        if (cancelled) return;
        setOrder(next);
        setErr(null);
        if (isSettled(next.status)) return; // stops on paid and on failed
      } catch (e) {
        if (cancelled) return;
        setErr("We couldn't load this order right now.");
      }
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // Authoritative success is the only trigger for emptying the cart. The ref
  // keeps it to one dispatch even though `order` is replaced on every poll.
  useEffect(() => {
    if (order && isPaid(order.status) && !clearedRef.current) {
      clearedRef.current = true;
      clear();
    }
  }, [order, clear]);

  // Until the backend answers, the order is unconfirmed — never "successful".
  const status = order?.status;
  const view = VIEW[status] || VIEW.pending;

  return (
    <App>
      <main className="page">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="panel" style={{ textAlign: "center" }}>
            <div style={{ fontSize: "3rem", marginBottom: 10 }}>{view.icon}</div>
            <span className={`status-badge ${view.cls}`}>{view.badge}</span>
            <h2 className="section-title" style={{ marginTop: 16 }}>{view.title}</h2>
            {params.get("sim") && (
              <p className="lead" style={{ margin: "0 auto 10px" }}>
                (Simulated payment — add AirPay credentials to process real payments.)
              </p>
            )}
            <p className="lead" style={{ margin: "0 auto" }}>Order ID: <b>{id}</b></p>
            {view.note && (
              <p className="lead" style={{ margin: "14px auto 0" }}>{view.note}</p>
            )}
            {timedOut && !isSettled(status) && (
              <p className="lead" style={{ margin: "14px auto 0" }}>
                This is taking longer than usual. Refresh this page to check again — we'll
                email you once the payment is confirmed.
              </p>
            )}

            {err && <div className="notice err" style={{ marginTop: 20 }}>{err}</div>}

            {order && (
              <div style={{ textAlign: "left", marginTop: 24 }}>
                {order.items.map((i) => (
                  <div className="summary-line" key={i.id}>
                    <span>{i.title} × {i.qty}</span>
                    <span>{inr(i.price * i.qty)}</span>
                  </div>
                ))}
                <div className="summary-total"><span>Total</span><span>{inr(order.total)}</span></div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginTop: 28 }}>
              {status === "failed" && (
                // Back to checkout with the cart intact: a retry must create a
                // fresh backend payment attempt, never replay the old form.
                <Link to="/checkout" className="btn btn-accent">Try payment again</Link>
              )}
              <Link to="/" className="btn btn-primary">Back to home</Link>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </App>
  );
}
