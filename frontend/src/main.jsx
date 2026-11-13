import React from "react";
import ReactDOM from "react-dom/client";
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { CartProvider } from "./context/CartContext.jsx";
import { RouteSeo } from "./seo.js";
import Home from "./pages/Home.jsx";
import Shop from "./pages/Shop.jsx";
import ProductDetail from "./pages/ProductDetail.jsx";
import About from "./pages/About.jsx";
import Faq from "./pages/Faq.jsx";
import Policies from "./pages/Policies.jsx";
import ContactPage from "./pages/ContactPage.jsx";
import Checkout from "./pages/Checkout.jsx";
import OrderStatus from "./pages/OrderStatus.jsx";
import TermsAndConditions from "./pages/TermsAndConditions.jsx";
import RefundAndCancellationPolicy from "./pages/RefundAndCancellationPolicy.jsx";
import ShippingAndDeliveryPolicy from "./pages/ShippingAndDeliveryPolicy.jsx";
import DataNotice from "./pages/DataNotice.jsx";
import NotFound from "./pages/NotFound.jsx";
import "./styles/global.css";

// Scroll to the #anchor if present, otherwise to the top, on every navigation.
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const el = hash && document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CartProvider>
      <BrowserRouter>
        <ScrollManager />
        <RouteSeo />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/shop" element={<Shop />} />
          <Route path="/product/:id" element={<ProductDetail />} />
          <Route path="/about" element={<About />} />
          <Route path="/faq" element={<Faq />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/order/:id" element={<OrderStatus />} />
          <Route path="/terms-and-conditions" element={<TermsAndConditions />} />
          <Route path="/refund-and-cancellation-policy" element={<RefundAndCancellationPolicy />} />
          <Route path="/shipping-and-delivery-policy" element={<ShippingAndDeliveryPolicy />} />
          <Route path="/privacy-policy" element={<DataNotice />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </CartProvider>
  </React.StrictMode>
);
