import { Link } from "react-router-dom";
import App from "../App.jsx";
import Contact from "../components/Contact.jsx";
import Footer from "../components/Footer.jsx";

export default function ContactPage() {
  return (
    <App>
      <main>
        <div className="container">
          <header className="page-head" style={{ paddingTop: 60 }}>
            <span className="eyebrow">Contact us</span>
            <h1>Contact Firvanra</h1>
            <p className="lead">
              For help with an order, payment or refund, please email or call us and include your order ID so we can reply directly.
              Common questions are answered in the <Link className="text-link" to="/faq">FAQ</Link>.
            </p>
          </header>
        </div>
        <Contact />
      </main>
      <Footer />
    </App>
  );
}
