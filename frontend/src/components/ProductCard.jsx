import { Link } from "react-router-dom";
import { useCart } from "../context/CartContext.jsx";
import { TYPE_LABEL, inr } from "../content/products.js";

// One card for every listing (home sections and /shop). Detail lives on /product/:id.
export default function ProductCard({ product, onAdded }) {
  const { add } = useCart();
  const to = `/product/${product.id}`;
  return (
    <article className="card product">
      <span className="cat">{TYPE_LABEL[product.type]}</span>
      <h3><Link to={to}>{product.title}</Link></h3>
      <p>{product.blurb}</p>
      <div className="price">{inr(product.price)}</div>
      <div className="card-actions">
        <button className="btn btn-accent" onClick={() => { add(product); onAdded?.(); }}>
          Add to cart<span className="sr-only">: {product.title}</span>
        </button>
        <Link to={to} className="btn btn-ghost">
          Details<span className="sr-only">: {product.title}</span>
        </Link>
      </div>
    </article>
  );
}
