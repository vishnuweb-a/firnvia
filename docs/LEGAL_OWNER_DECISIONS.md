# Legal pages — owner decisions and launch blockers

Pages: `/terms-and-conditions`, `/refund-and-cancellation-policy`, `/privacy-policy`.
Status: **DRAFT v0.1, not lawyer-reviewed, not approved.** Highlighted yellow text on each page marks open items.
To publish: resolve items below, then in `frontend/src/legal/company.js` set `DRAFT = false`, `EFFECTIVE_DATE`, and `LEGAL_VERSION`.

## Owner must decide / supply
1. Grievance Officer name, designation, contact and response time (not invented).
2. CIN, GSTIN, registered-office confirmation. Whether prices include GST; whether tax invoices are issued.
3. Refund service levels (proposed: ack 2 business days, review 7, initiation 5 after approval).
4. Whether any pre-commencement deduction applies; standard maintenance period; revision count / delivery timeframe.
5. Ownership of paid Deliverables; liability cap.
6. How ebooks are actually delivered, and by when.
7. Retention periods; privacy-request response time; hosting regions.
8. Who operates kkchat.in, why SabPaisa/AirPay2 payloads go there, and the basis for sharing.
9. Confirm firvanra@gmail.com is monitored and handled.

## Launch blockers outside this task's scope (not changed)
- `/api/contact` only `console.log`s name/email/phone/message — messages are not stored or emailed; contact data sits in server logs.
- Orders are in process memory only: no durable order, refund or consent record. Acceptance of Terms at checkout is **not recorded** server-side.
- No refund/cancellation API, admin tool, or reliable email notification. Refunds are manual.
- No automated ebook delivery.
- Payload forwarding to kkchat.in is unverified (see backend/routes/payment.js comments).

## Legal references to verify with counsel (checked from memory/secondary sources, not primary text)
- Consumer Protection Act, 2019; Consumer Protection (E-Commerce) Rules, 2020 as amended — applicability to Firvanra's model (grievance officer disclosure) to be confirmed.
- DPDP Act 2023; DPDP Rules 2025 notified 13 Nov 2025 (Gazette 14 Nov): Rules 1, 2, 17–21 immediate; Rule 4 after 1 year; Rules 3, 5–16, 22–23 after 18 months (~13–14 May 2027). Verify against the Gazette text.
- IT Act 2000 / SPDI Rules 2011 continue to apply until DPDP s.44 amendments commence.
- RBI payment/refund rules bind banks and payment providers; no merchant deadline is asserted in the pages.
- Official sources: consumeraffairs.gov.in, meity.gov.in, rbi.org.in, indiacode.nic.in.

## Small copy changes made to existing pages
`OrderStatus.jsx`: removed "No money has been captured" and "we'll email you" (the code cannot guarantee either); now tells the customer to check their bank and contact support.
