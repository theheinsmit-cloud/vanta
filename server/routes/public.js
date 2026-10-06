const express = require("express");
const multer = require("multer");
const { getPricing, createOrder, imageInfo, MAX_ITEMS, MAX_QTY } = require("../lib/orders");
const { HttpError } = require("../lib/util");
const { activePromo } = require("../../site/assets/js/pricing");
const cfg = require("../config");
const ik = require("../lib/ikhokha");
const payments = require("../lib/payments");

// Where customers come back to and where iKhokha posts notifications (fixed in production).
const publicBase = (req) => cfg.PUBLIC_URL || req.protocol + "://" + req.get("host");
const { sameOrigin } = require("../auth");

const router = express.Router();
router.use(sameOrigin);

// One original plus up to 4 panel files per print, up to MAX_ITEMS prints per order.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: MAX_ITEMS * 5, fields: 30, fieldSize: 100 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(original|panel)-([1-9]|10)$/.test(file.fieldname))
}).any();

// Light spam guard: max 20 orders per IP per hour.
const hits = new Map();
function orderLimit(req, res, next) {
  const ip = req.socket.remoteAddress || "?";
  const rec = hits.get(ip);
  if (!rec || rec.resetAt < Date.now()) hits.set(ip, { count: 1, resetAt: Date.now() + 3600 * 1000 });
  else if (++rec.count > 20) return res.status(429).json({ error: "Too many orders from this connection. Please try again later." });
  next();
}

router.get("/pricing", (req, res) => {
  // Config for pricing.js in the browser (cents). The server recalculates every order regardless.
  const p = getPricing();
  res.set("Cache-Control", "no-store");
  // promo is only sent while it runs (server clock); pages also drop it themselves at endsAt.
  res.json({ pricePerPanelCents: p.pricePerPanelCents, handlingCents: p.handlingCents, tiers: p.tiers, promo: activePromo(p), onlinePayment: ik.isConfigured(), maxItems: MAX_ITEMS, maxQty: MAX_QTY });
});

router.post("/orders", orderLimit, (req, res, next) => {
  upload(req, res, (err) => {
    if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "One of the files is too large." : "The upload could not be read." });
    next();
  });
}, async (req, res) => {
  try {
    const b = req.body || {};
    let meta;
    try { meta = JSON.parse(b.items || "[]"); } catch (e) { throw new HttpError(400, "Order details are invalid."); }
    if (!Array.isArray(meta) || !meta.length) throw new HttpError(400, "Your order has no prints in it.");
    if (meta.length > MAX_ITEMS) throw new HttpError(400, "An order can hold up to " + MAX_ITEMS + " different prints.");

    // Files arrive as original-<n> and panel-<n> (n = print number, 1-based), panels in the order listed in meta.
    const byField = {};
    for (const f of req.files || []) (byField[f.fieldname] = byField[f.fieldname] || []).push(f);

    const items = meta.map((m, i) => {
      const no = i + 1, label = "Print " + no;
      const originalFile = (byField["original-" + no] || [])[0];
      if (!originalFile) throw new HttpError(400, label + ": the original image is missing.");
      const originalInfo = imageInfo(originalFile.buffer);
      if (!originalInfo) throw new HttpError(400, label + ": please upload a JPG or PNG image.");

      const panelFiles = byField["panel-" + no] || [];
      const panelMeta = Array.isArray(m && m.panels) ? m.panels : [];
      if (panelMeta.length !== panelFiles.length) throw new HttpError(400, label + ": panel details don't match the files.");
      const seen = new Set();
      const panels = panelFiles.map((f, j) => {
        const info = imageInfo(f.buffer);
        const index = Number(panelMeta[j] && panelMeta[j].index);
        if (!info) throw new HttpError(400, label + ": a print file isn't a valid image.");
        if (!Number.isInteger(index) || index < 1 || index > 8 || seen.has(index)) throw new HttpError(400, label + ": panel numbering is invalid.");
        seen.add(index);
        return { buffer: f.buffer, info, index, label: String((panelMeta[j] && panelMeta[j].label) || "").slice(0, 40) };
      });
      return {
        layout: m.layout, orientation: m.orientation, arrangement: m.arrangement, qty: Number(m.qty),
        dpi: Number(m.dpi), lowResConfirmed: m.lowResConfirmed === true,
        original: { buffer: originalFile.buffer, info: originalInfo, name: originalFile.originalname }, panels
      };
    });

    const result = createOrder({
      firstName: b.firstName, lastName: b.lastName, email: b.email, phone: b.phone,
      address: b.address, city: b.city, postal: b.postal, rightsConfirmed: b.rights === "true",
      expectedTotalCents: b.expectedTotalCents === undefined || b.expectedTotalCents === "" ? null : Number(b.expectedTotalCents)
    }, items);

    // Always pay online when iKhokha is set up: the order is saved first, then the customer goes to pay.
    if (!ik.isConfigured()) return res.status(201).json({ ok: true, orderNumber: result.orderNumber });
    const order = payments.findOrder(result.orderNumber);
    try {
      const pay = await payments.startPayment(order, publicBase(req));
      res.status(201).json({ ok: true, orderNumber: result.orderNumber, payUrl: pay.paylinkUrl, payToken: pay.token });
    } catch (e) {
      console.error("Could not start payment for " + result.orderNumber + ": " + e.message);
      res.status(201).json({ ok: true, orderNumber: result.orderNumber, payToken: payments.ensureToken(payments.findOrder(result.orderNumber)), payError: "We saved your order but couldn't open the payment page. Please try again." });
    }
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, pricesChanged: err.status === 409 });
    console.error("Order creation failed:", err);
    res.status(500).json({ error: "Something went wrong saving your order. Please try again." });
  }
});


/* ---------- online payment (iKhokha) ---------- */
// A new payment link for an unpaid order (e.g. after a failed or cancelled attempt). Needs the order's private token.
router.post("/payments/start", express.json({ limit: "10kb" }), async (req, res) => {
  try {
    const o = payments.orderForToken(req.body && req.body.order, req.body && req.body.token);
    const pay = await payments.startPayment(o, publicBase(req));
    res.json({ payUrl: pay.paylinkUrl });
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof HttpError ? err.message : "Something went wrong. Please try again." });
  }
});

// The payment page polls this; check=1 also asks iKhokha directly (rate-limited per order).
router.get("/payments/status", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await payments.publicStatus(req.query.order, req.query.t, req.query.check === "1")); }
  catch (err) { res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof HttpError ? err.message : "Something went wrong." }); }
});

// iKhokha's webhook (server to server). The raw body is kept for signature checking.
router.post("/payments/ikhokha/callback", express.json({ limit: "20kb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }), async (req, res) => {
  try { await payments.handleWebhook(req.rawBody, req.body || {}, req.headers["ik-sign"]); }
  catch (err) { console.error("iKhokha webhook handling failed: " + err.message); }
  res.sendStatus(200);
});

module.exports = router;
