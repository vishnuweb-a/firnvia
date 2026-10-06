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
              <li><a href="#home">Home</a></li>
              <li><a href="#services">Services</a></li>
              <li><a href="#contact">Contact us</a></li>
              <li><a href="#">Terms & Conditions</a></li>
              <li><a href="#">Privacy Policy</a></li>
              <li><a href="#">Refund & Cancellation</a></li>
            </ul>
          </div>
          <div>
            <h4>Contact info</h4>
            <ul>
              <li>UG-2, Vijay Block, Laxmi Nagar, East Delhi, Delhi 110092</li>
              <li>Phone: 7669438261</li>
              <li>Email: firvanra@gmail.com</li>
            </ul>
          </div>
        </div>
        <div className="copy">© {new Date().getFullYear()} Firvanra Solutions Pvt. Ltd. All rights reserved.</div>
      </div>
    </footer>
  );
}
