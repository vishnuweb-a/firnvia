import { useCart } from "../context/CartContext.jsx";

const inr = (n) => `₹${n.toLocaleString("en-IN")}`;

export default function EbookShop({ ebooks, onAdded }) {
  const { add } = useCart();
  return (
    <section className="section" id="shop" style={{ background: "#eef2fb" }}>
      <div className="container">
        <span className="eyebrow">Online Growth Hub</span>
        <h2 className="section-title">Digital products & ebooks</h2>
        <p className="lead">
          Practical guides for websites, branding, automation, and scalable growth.
        </p>
        <div className="grid grid-4" style={{ marginTop: 36 }}>
          {ebooks.map((b) => (
            <article className="card product" key={b.id}>
              <div className="thumb">
                {/* Replace with <img src={b.image} alt={b.title} /> */}
                <span>{b.title}</span>
              </div>
              <span className="cat">{b.category}</span>
              <h3 style={{ fontSize: "1.02rem", margin: "6px 0 4px" }}>{b.title}</h3>
              <div className="price">{inr(b.price)}</div>
              <button className="btn btn-accent" onClick={() => { add(b); onAdded?.(); }}>
                Add to cart
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
