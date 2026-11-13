import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { COMPANY } from "./legal/company.js";

// Per-route title and meta description. Product pages set their own once loaded.
export const ROUTE_SEO = {
  "/": ["Firvanra — Software & IT Growth Partner", "Firvanra offers website, WordPress and automation services and practical business ebooks, with prices listed in INR and online checkout."],
  "/shop": ["Shop all services & ebooks — Firvanra", "Browse every Firvanra service package and ebook in one place. Filter by category, search by name and view full details before you order."],
  "/about": ["About us — Firvanra", "What Firvanra sells, how we describe and price our services and ebooks, how ordering works and how to reach our team."],
  "/faq": ["FAQ — Firvanra", "Answers about ordering, payments, order status, delivery of services and ebooks, cancellations, refunds and contacting Firvanra support."],
  "/policies": ["Policies — Firvanra", "All Firvanra policies in one place: Privacy Policy, Terms & Conditions, Shipping & Delivery Policy and Refund & Cancellation Policy."],
  "/contact": ["Contact us — Firvanra", "Contact Firvanra by email or phone for questions about services, ebooks, orders, payments and refunds."],
  "/privacy-policy": ["Privacy Policy — Firvanra", "What personal data Firvanra collects through its website, why it is used and who receives it."],
  "/terms-and-conditions": ["Terms & Conditions — Firvanra", "The terms that apply when you use the Firvanra website and buy services or digital products."],
  "/shipping-and-delivery-policy": ["Shipping & Delivery Policy — Firvanra", "How Firvanra delivers services and ebooks. We sell digital services and products only, so nothing is physically shipped."],
  "/refund-and-cancellation-policy": ["Refund & Cancellation Policy — Firvanra", "How order cancellations, refunds and payment problems are handled for Firvanra services and digital products."],
};

const head = (selector) => document.head.querySelector(selector);

export function setSeo({ title, description, path, noindex = false }) {
  document.title = title;
  head('meta[name="description"]')?.setAttribute("content", description);
  head('link[rel="canonical"]')?.setAttribute("href", COMPANY.website + (path === "/" ? "/" : path));
  head('meta[name="robots"]')?.setAttribute("content", noindex ? "noindex" : "index,follow");
}

// Mounted once inside the router. Checkout, order status and unknown URLs get a
// generic title and are kept out of search indexes.
export function RouteSeo() {
  const { pathname } = useLocation();
  useEffect(() => {
    const known = ROUTE_SEO[pathname];
    if (known) setSeo({ title: known[0], description: known[1], path: pathname });
    else setSeo({ title: "Firvanra", description: ROUTE_SEO["/"][1], path: pathname, noindex: !pathname.startsWith("/product/") });
  }, [pathname]);
  return null;
}
