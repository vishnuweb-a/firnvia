import { Link } from "react-router-dom";
import { COMPANY } from "../legal/company.js";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <div className="brand" style={{ color: "#fff", marginBottom: 14 }}>
              Firv<span style={{ color: "var(--accent)" }}>anra</span>
            </div>
            <p style={{ fontSize: "0.92rem" }}>
              {COMPANY.legalName} is a technology-driven company
              delivering reliable, secure, and scalable digital solutions to help
              businesses simplify operations and grow.
            </p>
          </div>
          <nav aria-label="Footer">
            <h4>Useful links</h4>
            <ul>
              <li><Link to="/">Home</Link></li>
              <li><Link to="/shop">Shop</Link></li>
              <li><Link to="/about">About Us</Link></li>
              <li><Link to="/faq">FAQ</Link></li>
              <li><Link to="/contact">Contact Us</Link></li>
            </ul>
          </nav>
          <nav aria-label="Policies">
            <h4>Policies</h4>
            <ul>
              <li><Link to="/policies">All policies</Link></li>
              <li><Link to="/privacy-policy">Privacy Policy</Link></li>
              <li><Link to="/terms-and-conditions">Terms &amp; Conditions</Link></li>
              <li><Link to="/shipping-and-delivery-policy">Shipping &amp; Delivery</Link></li>
              <li><Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation</Link></li>
            </ul>
          </nav>
          <div>
            <h4>Contact info</h4>
            <ul>
              <li>{COMPANY.address}</li>
              <li>Phone: <a href={`tel:+91${COMPANY.phone}`}>{COMPANY.phone}</a></li>
              <li>Email: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a></li>
            </ul>
          </div>
        </div>
        <div className="copy">© {new Date().getFullYear()} {COMPANY.legalName} All rights reserved.</div>
      </div>
    </footer>
  );
}
