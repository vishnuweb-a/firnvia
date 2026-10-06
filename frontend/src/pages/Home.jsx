import { useEffect, useState } from "react";
import App from "../App.jsx";
import Hero from "../components/Hero.jsx";
import Services from "../components/Services.jsx";
import EbookShop from "../components/EbookShop.jsx";
import MicroServices from "../components/MicroServices.jsx";
import Testimonials from "../components/Testimonials.jsx";
import Contact from "../components/Contact.jsx";
import Footer from "../components/Footer.jsx";
import { api } from "../api.js";

export default function Home() {
  const [products, setProducts] = useState([]);

  useEffect(() => {
    api.products().then(setProducts).catch(() => setProducts([]));
  }, []);

  const services = products.filter((p) => p.type === "service");
  const ebooks = products.filter((p) => p.type === "ebook");

  return (
    <App>
      {({ openCart }) => (
        <main>
          <Hero />
          <Services services={services} onAdded={openCart} />
          <EbookShop ebooks={ebooks} onAdded={openCart} />
          <MicroServices />
          <Testimonials />
          <Contact />
          <Footer />
        </main>
      )}
    </App>
  );
}
