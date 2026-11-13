# Multi-page site, FAQ, policies and catalogue — handoff

Scope: website content, navigation and presentation. Checkout, order status, payment utilities, the cart context, `frontend/vercel.json`, and every backend route and service are untouched. The only backend edit is in `backend/data/products.js`: the unused `image` paths were removed (ids, titles, blurbs, types and prices are unchanged).

Nothing here has been committed, pushed or deployed. All checks below were run locally.

## What the business sells

Digital services and ebooks only: 6 service packages and 4 ebooks in `backend/data/products.js`, plus one hidden payment-test product (`type: "test"`). There are no physical products, no stock, no variants, no shipping charges and no product artwork. The earlier brief mentioned a ₹199 handkerchief; no such product exists in the code and none was added.

## Routes

| URL | Status |
| --- | --- |
| `/` | existed; cards link to product pages; testimonials section removed |
| `/shop`, `/shop?category=service\|ebook` | new |
| `/product/:id` | new (10 products; the test product shows "Product not found", noindex, no structured data) |
| `/about`, `/faq`, `/policies`, `/contact` | new |
| `/shipping-and-delivery-policy` | new |
| `/privacy-policy`, `/terms-and-conditions`, `/refund-and-cancellation-policy` | existed; edits listed below |
| `/checkout`, `/order/:id` | existed, untouched |
| anything else | "Page not found" page, noindex |

Direct access and refresh rely on the existing catch-all rewrite in `frontend/vercel.json`. It is still the last rule, after the `/api`, AirPay callback and HDFC return rewrites (asserted in `legal.routing.test.js`). Static files such as `/favicon.svg` are served before rewrites apply.

## Corrections in the final pass

- **Testimonials removed.** "Client A/B/C" were placeholders presented as customer quotes. The component, its home-page section and its CSS are deleted. The site has no ratings or reviews anywhere, including structured data.
- **Contact form removed.** `POST /api/contact` only writes the message to the server log and then answers "Thanks — we'll be in touch shortly". No email provider, database or CRM is configured, so nobody receives it. The Contact section (home and `/contact`) now shows the address, an "Email us" button, a "Call" button and instructions. The frontend no longer calls the endpoint. FAQ, About, the page description and the Privacy Policy no longer mention a form.
- **Unapproved refund timings removed.** The Refund policy no longer shows the proposed 2 / 7 / 5 business-day targets, or "commonly takes several working days". It lists the steps and says no fixed timeframe is published for our own steps.
- **Gateway names in policies.** Terms and the Refund policy named "AirPay, SabPaisa and PayU"; checkout offers AirPay, AirPay 2, SabPaisa and PayU (plus HDFC UPI and ISGPay only when the backend enables them). They now refer to "the gateways shown at checkout".
- **Privacy Policy data-sharing corrected, not reduced.** It said SabPaisa and AirPay notifications are forwarded to kkchat.in. In the code, forwarding happens for SabPaisa (`backend/routes/payment.js`) and for the second AirPay merchant, shown at checkout as "AirPay 2" (`backend/routes/airpay2.js`). The original AirPay, PayU, HDFC and ISGPay routes do not forward. The policy now says exactly that.
- **Navigation.** Shop is highlighted on product pages and Policies on the four policy pages, on desktop and in the mobile menu.
- **Favicon.** `frontend/public/favicon.svg`: an "F" in the wordmark's two colours (ink `#0b1437`, teal `#11c2c2`). The project has no logo file; the text wordmark in the header is the only brand asset.
- **Image references.** Every `image: "/img/..."` path in the catalogue pointed to a file that does not exist and nothing read the field. They are removed, along with a commented-out hero image. Cards are text-only.
- **Micro services.** "Fast-turnaround" removed (no turnaround time is published); the section now says these are agreed by enquiry, not sold through the cart.

## Release blockers

1. **Policies are unapproved drafts.** All four pages show "Version 0.1 (draft)" and "Effective date: not yet published". That label is accurate and was left in place. Items 1–9 of `docs/LEGAL_OWNER_DECISIONS.md` are all open, and checkout asks customers to accept the Terms. The policies cannot be presented as final until the owner decides the items below and sets `EFFECTIVE_DATE` / `LEGAL_VERSION` in `frontend/src/legal/company.js`.
2. **Website Redesign Mini is ₹1.** Commit `4ef76dc` changed it from ₹849 with the note "(intentional)", one commit before sandbox card-test work. That does not establish it as a test listing: it is still `type: "service"` with real copy. It was therefore left as it is, and it is public: on the home page, in `/shop`, at `/product/website-redesign-mini` and in Product structured data with `price: 1`. The owner must either confirm ₹1 as the real price, restore the real price, or mark it `type: "test"` (which hides it everywhere with no other change).
3. **No way to receive a message through the site, and no confirmed inbox.** Support depends entirely on `firvanra@gmail.com` and `9355124568`. Nobody has confirmed the mailbox is monitored (decision 9).

## Decisions the owner still has to make

From `docs/LEGAL_OWNER_DECISIONS.md`, all still open:

1. Grievance Officer: name, designation, contact and response time.
2. CIN, GSTIN and registered-office confirmation; whether prices include GST; whether tax invoices are issued.
3. Refund service levels (acknowledgement, review, initiation). Nothing is published until approved.
4. Any pre-commencement deduction; standard maintenance period; revision count; service delivery timeframe.
5. Ownership of paid deliverables; liability cap.
6. How ebooks are actually delivered, and by when. The Terms, Shipping page, FAQ and product pages say "manually by our team, normally by email, not an instant download". No delivery mechanism exists in the code, so this wording is the owner's to confirm.
7. Data retention periods; privacy-request response time; hosting regions.
8. Who operates kkchat.in, why payment notifications are sent there, and the basis for sharing.
9. That `firvanra@gmail.com` is monitored, and by whom.

Also open:

10. Effective date and version number for each policy.
11. Whether to add a real enquiry form. It needs a delivery integration (email or CRM) first.
12. Real customer testimonials, if any are to be shown.
13. Product artwork, ebook page counts and file formats.
14. Prices, scope and delivery estimates for the six micro services, if they are to be sold online.
15. Whether any physical products are planned. If so, the catalogue and the Shipping and Refund policies need a second pass.

## Outside this task, not changed

- `POST /api/contact` still exists on the backend and still logs name, email, phone and message if called directly. No page calls it.
- Three service blurbs in `backend/data/products.js` contain claims nobody has verified: "fast" and "without downtime" (WordPress Error Fixing) and "A complete lead funnel" (Data & Automation Basics). They were left as written.
- `GET /api/products` returns the test product; it is hidden only by the frontend's type filter.
- Orders are held in server memory; there is no durable order, refund or consent record and no automated ebook delivery.

## Known limitations

- The site is a client-rendered SPA. Titles, descriptions, canonical URLs and Product JSON-LD are set in the browser, so crawlers that do not run JavaScript see only the defaults in `index.html`.
- `/checkout` titles the page with an `<h2>` and has no `<h1>` (existing behaviour, not changed).
- The favicon is SVG only; there is no `.ico` or Apple touch icon.
