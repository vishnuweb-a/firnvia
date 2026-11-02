import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="footer" id="about">
      <div className="container">
        <div className="footer-grid">
          <div>
            <div className="brand" style={{ color: "#fff", marginBottom: 14 }}>
              Firv<span style={{ color: "var(--accent)" }}>anra</span>
            </div>
            <p style={{ fontSize: "0.92rem" }}>
              Firvanra Solutions Pvt. Ltd. is a technology-driven company
              delivering reliable, secure, and scalable digital solutions to help
              businesses simplify operations and grow.
            </p>
          </div>
          <div>
            <h4>Useful links</h4>
            <ul>
              <li><Link to="/#home">Home</Link></li>
              <li><Link to="/#services">Services</Link></li>
              <li><Link to="/#contact">Contact us</Link></li>
              <li><Link to="/terms-and-conditions">Terms &amp; Conditions</Link></li>
              <li><Link to="/privacy-policy">Privacy Policy</Link></li>
              <li><Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation</Link></li>
            </ul>
          </div>
          <div>
            <h4>Contact info</h4>
            <ul>
              <li>UG-2, Vijay Block, Laxmi Nagar, East Delhi, Delhi 110092</li>
              <li>Phone: <a href="tel:+917669438261">7669438261</a></li>
              <li>Email: <a href="mailto:firvanra@gmail.com">firvanra@gmail.com</a></li>
            </ul>
          </div>
        </div>
        <div className="copy">© {new Date().getFullYear()} Firvanra Solutions Pvt. Ltd. All rights reserved.</div>
      </div>
    </footer>
  );
}
