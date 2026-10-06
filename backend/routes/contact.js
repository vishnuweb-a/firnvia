import { Router } from "express";

const router = Router();

// Stores nothing by default — wire to email (nodemailer) or a CRM as needed.
router.post("/", (req, res) => {
  const { firstName, email, phone, message } = req.body || {};
  if (!firstName || !email || !message)
    return res.status(400).json({ error: "Name, email and message are required." });

  // TODO: send via nodemailer / save to DB / forward to CRM.
  console.log("[contact]", { firstName, email, phone, message });
  res.json({ ok: true, message: "Thanks — we'll be in touch shortly." });
});

export default router;
