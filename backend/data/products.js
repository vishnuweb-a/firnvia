// Central product catalog. Replace copy/images with the client's real assets.
// Prices are in INR (paise are computed at payment time).

export const products = [
  // ---- Service packages ----
  {
    id: "website-redesign-mini",
    type: "service",
    title: "Website Redesign Mini",
    blurb:
      "A modern, clean refresh that improves visual appeal, mobile responsiveness, and overall user experience.",
    price: 849,
    image: "/img/services/redesign.png",
  },
  {
    id: "technical-website-audit",
    type: "service",
    title: "Technical Website Audit",
    blurb:
      "A full technical review covering performance, SEO, security, and usability to surface issues and improve site health.",
    price: 499,
    image: "/img/services/audit.png",
  },
  {
    id: "wordpress-care",
    type: "service",
    title: "WordPress Care Service",
    blurb:
      "Keep WordPress secure and smooth with regular maintenance, plugin updates, backups, and performance monitoring.",
    price: 999,
    image: "/img/services/care.png",
  },
  {
    id: "wordpress-error-fixing",
    type: "service",
    title: "WordPress Error Fixing",
    blurb:
      "Resolve WordPress errors, bugs, and technical issues fast to keep the site running securely without downtime.",
    price: 899,
    image: "/img/services/fixing.png",
  },
  {
    id: "conversion-optimization",
    type: "service",
    title: "Conversion Optimization Package",
    blurb:
      "Turn more visitors into leads with optimized layouts, CTAs, UX, and conversion-focused improvements.",
    price: 499,
    image: "/img/services/cro.png",
  },
  {
    id: "data-automation-basics",
    type: "service",
    title: "Data & Automation Basics",
    blurb:
      "A complete lead funnel with landing pages, forms, tracking, and automation to capture and manage prospects.",
    price: 999,
    image: "/img/services/automation.png",
  },

  // ---- Ebooks ----
  {
    id: "digital-security-ebook",
    type: "ebook",
    category: "ebooks",
    title: "Digital Security & Anti-Fraud Ebook",
    blurb: "Practical guidance to protect your business from digital fraud.",
    price: 399,
    image: "/img/ebooks/security.png",
  },
  {
    id: "analytics-tracking-ebook",
    type: "ebook",
    category: "ebooks",
    title: "Google Analytics & Simple Data Tracking Ebook",
    blurb: "Set up analytics and read your data without the jargon.",
    price: 129,
    image: "/img/ebooks/analytics.png",
  },
  {
    id: "performance-marketing-ebook",
    type: "ebook",
    category: "ebooks",
    title: "Performance Marketing Ebook",
    blurb: "Run ad campaigns that actually convert.",
    price: 199,
    image: "/img/ebooks/marketing.png",
  },
  {
    id: "social-media-ebook",
    type: "ebook",
    category: "ebooks",
    title: "Social Media Management Ebook",
    blurb: "Plan, post, and grow across social platforms.",
    price: 399,
    image: "/img/ebooks/social.png",
  },
];

// Hidden test product — only accessible via /payment-test, never shown in product listings
products.push({ id: "sabpaisa-test-10", type: "test", title: "SabPaisa Integration Test ₹10", blurb: "Hidden test product for payment gateway verification.", price: 10, image: "/img/services/audit.png" });

export const getProduct = (id) => products.find((p) => p.id === id);
