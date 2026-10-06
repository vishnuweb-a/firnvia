import { useNavigate } from "react-router-dom";
import { useCart } from "../context/CartContext.jsx";

const inr = (n) => `₹${n.toLocaleString("en-IN")}`;

export default function CartDrawer({ open, onClose }) {
  const { items, total, setQty, remove } = useCart();
  const navigate = useNavigate();

  return (
    <>
      <div className={`drawer-overlay ${open ? "open" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <h3>Your cart</h3>
          <button className="link-btn" onClick={onClose} style={{ fontSize: "1.2rem" }}>✕</button>
        </div>
        <div className="drawer-body">
          {items.length === 0 ? (
            <p className="empty">Your cart is empty. Add a service or ebook to get started.</p>
          ) : (
            items.map((i) => (
              <div className="cart-line" key={i.id}>
                <div className="ci-thumb" />
                <div className="ci-body">
                  <b>{i.title}</b>
                  <div className="row-between">
                    <div className="qty">
                      <button onClick={() => setQty(i.id, i.qty - 1)}>−</button>
                      <span>{i.qty}</span>
                      <button onClick={() => setQty(i.id, i.qty + 1)}>+</button>
                    </div>
                    <span>{inr(i.price * i.qty)}</span>
                  </div>
                  <button className="link-btn" onClick={() => remove(i.id)}>Remove</button>
                </div>
              </div>
            ))
          )}
        </div>
        {items.length > 0 && (
          <div className="drawer-foot">
            <div className="summary-total" style={{ marginBottom: 16 }}>
              <span>Total</span>
              <span>{inr(total)}</span>
            </div>
            <button
              className="btn btn-accent"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => { onClose(); navigate("/checkout"); }}
            >
              Checkout
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
