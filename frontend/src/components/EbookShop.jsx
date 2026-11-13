import { Link } from "react-router-dom";
import ProductCard from "./ProductCard.jsx";

export default function EbookShop({ ebooks, onAdded }) {
  return (
    <section className="section" id="shop" style={{ background: "#eef2fb" }}>
      <div className="container">
        <span className="eyebrow">Online Growth Hub</span>
        <h2 className="section-title">Digital products & ebooks</h2>
        <p className="lead">
          Practical guides for websites, branding, automation, and scalable growth.
        </p>
        <div className="grid grid-4" style={{ marginTop: 36 }}>
          {ebooks.map((b) => <ProductCard key={b.id} product={b} onAdded={onAdded} />)}
        </div>
        <p style={{ marginTop: 28 }}>
          <Link to="/shop" className="btn btn-primary">View all products</Link>
        </p>
      </div>
    </section>
  );
}
