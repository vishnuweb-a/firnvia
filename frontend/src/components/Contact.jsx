import { useState } from "react";
import { api } from "../api.js";

export default function Contact() {
  const [form, setForm] = useState({ firstName: "", email: "", phone: "", message: "" });
  const [status, setStatus] = useState(null); // { ok, msg }
  const [sending, setSending] = useState(false);

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async () => {
    setSending(true);
    setStatus(null);
    try {
      const r = await api.contact(form);
      setStatus({ ok: true, msg: r.message });
      setForm({ firstName: "", email: "", phone: "", message: "" });
    } catch (e) {
      setStatus({ ok: false, msg: e.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="section" id="contact" style={{ background: "#eef2fb" }}>
      <div className="container contact-grid">
        <div>
          <span className="eyebrow">Get in touch</span>
          <h2 className="section-title">Have a question?</h2>
          <div className="info-row">
            <div className="ic">📍</div>
            <div>
              <strong>Address</strong>
              <p style={{ color: "var(--muted)" }}>
                Firvanra Solutions Pvt. Ltd., UG-2, Vijay Block, Laxmi Nagar,
                East Delhi, Delhi 110092
              </p>
            </div>
          </div>
          <div className="info-row">
            <div className="ic">✉️</div>
            <div><strong>Email</strong><p style={{ color: "var(--muted)" }}>firvanra@gmail.com</p></div>
          </div>
          <div className="info-row">
            <div className="ic">📞</div>
            <div><strong>Phone</strong><p style={{ color: "var(--muted)" }}>7669438261</p></div>
          </div>
        </div>

        <div className="form">
          {status && (
            <div className={`notice ${status.ok ? "ok" : "err"}`}>{status.msg}</div>
          )}
          <div className="field">
            <label>First name *</label>
            <input name="firstName" value={form.firstName} onChange={change} />
          </div>
          <div className="field">
            <label>Email address *</label>
            <input name="email" type="email" value={form.email} onChange={change} />
          </div>
          <div className="field">
            <label>Phone number *</label>
            <input name="phone" value={form.phone} onChange={change} />
          </div>
          <div className="field">
            <label>Message *</label>
            <textarea name="message" rows="4" maxLength="180" value={form.message} onChange={change} />
            <small style={{ color: "var(--muted)" }}>{form.message.length} / 180</small>
          </div>
          <button className="btn btn-primary" disabled={sending} onClick={submit}>
            {sending ? "Sending..." : "Submit"}
          </button>
        </div>
      </div>
    </section>
  );
}
