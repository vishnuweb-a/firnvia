import { useState } from "react";
import Header from "./components/Header.jsx";
import CartDrawer from "./components/CartDrawer.jsx";

export default function App({ children }) {
  const [cartOpen, setCartOpen] = useState(false);
  return (
    <>
      <Header onCartClick={() => setCartOpen(true)} />
      {typeof children === "function" ? children({ openCart: () => setCartOpen(true) }) : children}
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </>
  );
}
