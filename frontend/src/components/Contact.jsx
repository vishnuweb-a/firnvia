import { COMPANY } from "../legal/company.js";

// No enquiry form: the backend has no way to deliver a message to anyone, so the
// site offers the email address and phone number from legal/company.js instead.
export default function Contact() {
  return (
    <section className="section" id="contact" style={{ background: "#eef2fb" }}>
      <div className="container contact-grid">
        <div>
          <span className="eyebrow">Get in touch</span>
          <h2 className="section-title">Have a question?</h2>
          <div className="info-row">
            <div className="ic" aria-hidden="true">📍</div>
            <div>
              <strong>Address</strong>
              <p style={{ color: "var(--muted)" }}>
                {COMPANY.legalName}, {COMPANY.address}
              </p>
            </div>
          </div>
          <div className="info-row">
            <div className="ic" aria-hidden="true">✉️</div>
            <div><strong>Email</strong><p><a className="text-link" href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a></p></div>
          </div>
          <div className="info-row">
            <div className="ic" aria-hidden="true">📞</div>
            <div><strong>Phone</strong><p><a className="text-link" href={`tel:+91${COMPANY.phone}`}>{COMPANY.phone}</a></p></div>
          </div>
        </div>

        <div className="form">
          <h3 style={{ marginBottom: 10 }}>How to reach us</h3>
          <p>This website does not have an online enquiry form. Please email or call us directly.</p>
          <ul style={{ margin: "12px 0 20px", paddingLeft: "1.3em" }}>
            <li>For an order, payment or refund, email us and include your order ID (it starts with “FIR-”).</li>
            <li>Tell us your name and the email address or phone number you used at checkout.</li>
            <li>Never send a PIN, password, OTP, full card number or CVV.</li>
          </ul>
          <div className="card-actions">
            <a className="btn btn-primary" href={`mailto:${COMPANY.email}`}>Email us</a>
            <a className="btn btn-ghost" href={`tel:+91${COMPANY.phone}`}>Call {COMPANY.phone}</a>
          </div>
        </div>
      </div>
    </section>
  );
}
