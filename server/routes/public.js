const express = require("express");
const multer = require("multer");
const { getPricing, createOrder, imageInfo } = require("../lib/orders");
const { rand, HttpError } = require("../lib/util");
const { sameOrigin } = require("../auth");

const router = express.Router();
router.use(sameOrigin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 10, fields: 30, fieldSize: 50 * 1024 }
}).fields([{ name: "original", maxCount: 1 }, { name: "panels", maxCount: 8 }]);

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
  const p = getPricing();
  res.set("Cache-Control", "no-store");
  res.json({ pricePerPanel: rand(p.pricePerPanelCents), shipping: rand(p.shippingCents) });
});

router.post("/orders", orderLimit, (req, res, next) => {
  upload(req, res, (err) => {
    if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "One of the files is too large." : "The upload could not be read." });
    next();
  });
}, (req, res) => {
  try {
    const b = req.body || {};
    const originalFile = req.files && req.files.original && req.files.original[0];
    const panelFiles = (req.files && req.files.panels) || [];
    if (!originalFile) throw new HttpError(400, "Your original image is missing.");

    const originalInfo = imageInfo(originalFile.buffer);
    if (!originalInfo) throw new HttpError(400, "Please upload a JPG or PNG image.");

    let meta;
    try { meta = JSON.parse(b.panelsMeta || "[]"); } catch (e) { throw new HttpError(400, "Panel details are invalid."); }
    if (!Array.isArray(meta) || meta.length !== panelFiles.length) throw new HttpError(400, "Panel details don't match the files.");

    const seen = new Set();
    const panels = panelFiles.map((f, i) => {
      const info = imageInfo(f.buffer);
      const index = Number(meta[i] && meta[i].index);
      if (!info) throw new HttpError(400, "A print file isn't a valid image.");
      if (!Number.isInteger(index) || index < 1 || index > 8 || seen.has(index)) throw new HttpError(400, "Panel numbering is invalid.");
      seen.add(index);
      return { buffer: f.buffer, info, index, label: String((meta[i] && meta[i].label) || "").slice(0, 40) };
    });

    const result = createOrder({
      layout: b.layout, orientation: b.orientation, arrangement: b.arrangement,
      firstName: b.firstName, lastName: b.lastName, email: b.email, phone: b.phone,
      address: b.address, city: b.city, postal: b.postal,
      rightsConfirmed: b.rights === "true", lowResConfirmed: b.lowResConfirmed === "true",
      dpi: Number(b.dpi)
    }, { original: { buffer: originalFile.buffer, info: originalInfo, name: originalFile.originalname }, panels });

    res.status(201).json({ ok: true, orderNumber: result.orderNumber });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Order creation failed:", err);
    res.status(500).json({ error: "Something went wrong saving your order. Please try again." });
  }
});

module.exports = router;
