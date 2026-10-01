const express = require("express");
const multer = require("multer");
const { getPricing, createOrder, imageInfo, MAX_ITEMS, MAX_QTY } = require("../lib/orders");
const { HttpError } = require("../lib/util");
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
  res.json({ pricePerPanelCents: p.pricePerPanelCents, handlingCents: p.handlingCents, tiers: p.tiers, maxItems: MAX_ITEMS, maxQty: MAX_QTY });
});

router.post("/orders", orderLimit, (req, res, next) => {
  upload(req, res, (err) => {
    if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "One of the files is too large." : "The upload could not be read." });
    next();
  });
}, (req, res) => {
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

    res.status(201).json({ ok: true, orderNumber: result.orderNumber });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, pricesChanged: err.status === 409 });
    console.error("Order creation failed:", err);
    res.status(500).json({ error: "Something went wrong saving your order. Please try again." });
  }
});

module.exports = router;
