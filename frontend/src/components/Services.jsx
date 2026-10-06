import { useCart } from "../context/CartContext.jsx";

const inr = (n) => `₹${n.toLocaleString("en-IN")}`;

export default function Services({ services, onAdded }) {
  const { add } = useCart();
  return (
    <section className="section" id="services">
      <div className="container">
        <span className="eyebrow">Firvanra.online</span>
        <h2 className="section-title">Services for results, driven by expertise</h2>
        <p className="lead">
          End-to-end, 360° services that give you complete solutions under one roof.
        </p>
        <div className="grid grid-3" style={{ marginTop: 36 }}>
          {services.map((s) => (
            <article className="card" key={s.id}>
              <h3>{s.title}</h3>
              <p>{s.blurb}</p>
              <div className="price">{inr(s.price)}</div>
              <button
                className="btn btn-accent"
                onClick={() => { add(s); onAdded?.(); }}
              >
                Buy now @ {s.price}
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
