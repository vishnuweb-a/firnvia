import { useEffect, useState } from "react";
import { api } from "../api.js";

// Product ids, titles, prices and blurbs come from the backend catalogue
// (backend/data/products.js). This file only adds page copy, and every line is
// a restatement of that blurb or of the published Terms — do not add
// specifications (page counts, formats, timeframes) that the owner has not supplied.

// Listed types. Anything else (e.g. the hidden "test" product) is never shown.
export const CATEGORIES = { service: "Services", ebook: "Ebooks" };
export const TYPE_LABEL = { service: "Service", ebook: "Ebook" };

export const inr = (n) => `₹${n.toLocaleString("en-IN")}`;

export const DETAILS = {
  "website-redesign-mini": {
    covers: ["A modern, clean visual refresh", "Mobile responsiveness", "Overall user experience"],
    use: "For an existing website that looks dated or is awkward to use on a phone and needs a refresh, not a rebuild from scratch.",
  },
  "technical-website-audit": {
    covers: ["Performance", "SEO", "Security", "Usability"],
    use: "For site owners who want to know what is holding their website back before deciding what to fix. The audit surfaces issues and points to improvements in site health.",
  },
  "wordpress-care": {
    covers: ["Regular maintenance", "Plugin updates", "Backups", "Performance monitoring"],
    use: "For WordPress site owners who want routine upkeep handled for them.",
    note: "Ask us which period your order covers before you buy. The website does not set up automatic renewal or recurring billing; a renewal is a new order.",
  },
  "wordpress-error-fixing": {
    covers: ["WordPress errors", "Bugs", "Technical issues affecting how the site runs"],
    use: "For a WordPress site that is showing errors or misbehaving and needs to be brought back to normal working order.",
  },
  "conversion-optimization": {
    covers: ["Page layouts", "Calls to action (CTAs)", "User experience", "Conversion-focused improvements"],
    use: "For a website that gets visitors but too few enquiries or leads.",
    note: "Results such as sales or lead numbers depend on factors outside our control and are not guaranteed.",
  },
  "data-automation-basics": {
    covers: ["Landing pages", "Forms", "Tracking", "Automation to capture and manage prospects"],
    use: "For businesses that want a basic lead funnel set up end to end.",
  },
  "digital-security-ebook": {
    covers: ["Digital security for businesses", "Recognising and preventing digital fraud"],
    use: "For business owners and teams who want practical guidance on protecting the business from digital fraud.",
  },
  "analytics-tracking-ebook": {
    covers: ["Setting up analytics", "Reading your data in plain language"],
    use: "For anyone who wants to set up analytics and understand their numbers without the jargon.",
  },
  "performance-marketing-ebook": {
    covers: ["Running ad campaigns", "Improving how well campaigns convert"],
    use: "For people running, or about to run, paid ad campaigns.",
  },
  "social-media-ebook": {
    covers: ["Planning content", "Posting", "Growing across social platforms"],
    use: "For people managing social media for a business or brand.",
  },
};

// Catalogue from the API, limited to listed types.
export function useProducts() {
  const [state, setState] = useState({ products: [], loading: true, error: false });
  useEffect(() => {
    let live = true;
    api.products()
      .then((all) => live && setState({ products: all.filter((p) => CATEGORIES[p.type]), loading: false, error: false }))
      .catch(() => live && setState({ products: [], loading: false, error: true }));
    return () => { live = false; };
  }, []);
  return state;
}
