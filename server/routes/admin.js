const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const auth = require("../auth");
const cfg = require("../config");
const { db } = require("../db");
const orders = require("../lib/orders");
const fin = require("../lib/finance");
const payments = require("../lib/payments");
const ik = require("../lib/ikhokha");
const { renderInvoice } = require("../lib/invoice");
const { buildZip } = require("../lib/zip");
const { STATUSES, LAYOUT_LABEL } = require("../lib/constants");
const { toCents, HttpError } = require("../lib/util");

const router = express.Router();
const receiptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20, fieldSize: 20 * 1024 } }).single("receipt");

// Wraps handlers so thrown HttpErrors become clean JSON responses.
// Wraps sync and async handlers alike, turning errors into JSON responses.
const h = (fn) => (req, res) => {
  const fail = (err) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Admin error:", err);
    res.status(500).json({ error: "Something went wrong." });
  };
  try {
    const r = fn(req, res);
    if (r && typeof r.catch === "function") r.catch(fail);
  } catch (err) { fail(err); }
};
const id = (req) => {
  const n = parseInt(req.params.id, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "Not found.");
  return n;
};
const optCents = (v) => (v === undefined || v === null || v === "" ? null : toCents(v));

/* ---------- pages ---------- */
router.get("/", (req, res) => {
  if (!req.session) return res.type("html").send(auth.loginPage({ configured: auth.isConfigured() }));
  res.sendFile(path.join(cfg.ADMIN_DIR, "index.html"));
});

router.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
  const ip = req.socket.remoteAddress || "?";
  if (!auth.isConfigured()) return res.status(503).type("html").send(auth.loginPage({ configured: false }));
  const wait = auth.throttle(ip);
  if (wait) return res.status(429).type("html").send(auth.loginPage({ configured: true, error: "Too many attempts. Try again in " + wait + " minute" + (wait > 1 ? "s" : "") + "." }));

  const username = String((req.body && req.body.username) || "");
  const password = String((req.body && req.body.password) || "");
  const userOk = auth.safeEqual(username, cfg.ADMIN_USERNAME);
  const passOk = auth.verifyPassword(password, userOk ? cfg.ADMIN_PASSWORD_HASH : auth.DUMMY_HASH);
  if (userOk && passOk) {
    auth.attempts.delete(ip);
    auth.createSession(res, ip);
    return res.redirect(303, "/admin");
  }
  auth.recordFailure(ip);
  res.status(401).type("html").send(auth.loginPage({ configured: true, error: "Incorrect username or password." }));
});

router.use("/static", auth.requirePage, express.static(path.join(cfg.ADMIN_DIR, "static"), { index: false, etag: false, lastModified: false }));

router.get("/orders/:id/invoice", auth.requirePage, (req, res) => {
  try {
    const o = orders.getRow(id(req));
    res.type("html").send(renderInvoice(o));
  } catch (err) { res.status(err.status || 500).type("text").send(err.message || "Error"); }
});

/* ---------- API ---------- */
const api = express.Router();
api.use(auth.requireApi);
router.use("/api", express.json({ limit: "200kb" }), api);

api.get("/session", (req, res) => res.json({
  csrf: req.session.csrf,
  statuses: STATUSES,
  layouts: LAYOUT_LABEL,
  expenseCategories: fin.EXPENSE_CATEGORIES,
  expenseTypes: fin.EXPENSE_TYPES
}));

api.post("/logout", (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

api.get("/dashboard", h((req, res) => res.json(fin.dashboard())));

/* orders */
api.get("/orders", h((req, res) => res.json({ orders: orders.listOrders({
  q: String(req.query.q || ""), status: String(req.query.status || ""), payment: String(req.query.payment || ""), archived: String(req.query.archived || "")
}) })));
api.get("/orders/:id", h((req, res) => res.json(orders.getOrderDetail(id(req)))));
api.post("/orders/:id/status", h((req, res) => res.json({ order: orders.changeStatus(id(req), String(req.body.status || ""), { note: req.body.note, shipping: req.body.shipping }) })));
api.post("/orders/:id/notes", h((req, res) => res.json({ order: orders.setNotes(id(req), req.body.notes) })));
api.post("/orders/:id/shipping", h((req, res) => res.json({ order: orders.updateShipping(id(req), req.body) })));
api.post("/orders/:id/payment", h((req, res) => {
  const b = req.body || {};
  if (b.action === "unpaid") return res.json({ order: orders.markUnpaid(id(req)) });
  if (b.action !== "paid") throw new HttpError(400, "Unknown payment action.");
  res.json({ order: orders.markPaid(id(req), { amountCents: optCents(b.amount), method: b.method, reference: b.reference, date: b.date || "" }) });
}));
api.post("/orders/:id/refund", h((req, res) => res.json({ order: orders.recordRefund(id(req), { amountCents: optCents(req.body.amount), reason: req.body.reason }) })));
// Online payment (iKhokha): ask iKhokha whether this order has been paid, and record it if so.
api.post("/orders/:id/payment-check", h(async (req, res) => {
  const r = await payments.confirm(orders.getRow(id(req)));
  res.json({ paid: r.paid, order: orders.orderView(orders.getRow(id(req))) });
}));
// A small live test payment (not tied to an order) to prove the keys work; refund it in the iKhokha dashboard.
api.post("/payments/test", h(async (req, res) => {
  const cents = Math.round(Number(req.body.amount) * 100);
  res.json(await payments.startTestPayment(cents, cfg.PUBLIC_URL || req.protocol + "://" + req.get("host")));
}));
api.get("/payments/test/:pid", h(async (req, res) => res.json(await ik.getStatus(req.params.pid))));

api.post("/orders/:id/archive", h((req, res) => res.json({ order: orders.setArchived(id(req), !!req.body.archived) })));

api.get("/orders/:id/files/:fid", h((req, res) => {
  const f = orders.getOrderFile(id(req), parseInt(req.params.fid, 10));
  res.setHeader("Cache-Control", "private, no-store");
  if (req.query.download) return res.download(f.path, f.downloadName);
  res.type(f.mime).sendFile(f.path);
}));

api.get("/orders/:id/download-all", h((req, res) => {
  const detail = orders.getOrderDetail(id(req));
  // One folder per print, e.g. "print-2 (Duo x3)/print-files/...", so copies and crops never get mixed up.
  const folder = {};
  for (const it of detail.order.items) folder[it.id] = "print-" + it.no + " (" + it.layoutLabel + (it.qty > 1 ? " x" + it.qty : "") + ")/";
  const entries = detail.files.map((f) => {
    const file = orders.getOrderFile(detail.order.id, f.id);
    return { name: (folder[f.itemId] || "") + (f.kind === "original" ? "original/" : "print-files/") + f.downloadName, data: fs.readFileSync(file.path) };
  });
  if (!entries.length) throw new HttpError(404, "This order has no files.");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="' + detail.order.orderNumber + '-files.zip"');
  res.send(buildZip(entries));
}));

api.get("/customer", h((req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "Email required.");
  const list = orders.customerOrders(email);
  if (!list.length) throw new HttpError(404, "No orders for this customer.");
  res.json({ customer: list[0].customer, orders: list });
}));

/* finance */
api.get("/finance/income", h((req, res) => res.json(fin.incomeSummary(String(req.query.from || ""), String(req.query.to || "")))));
api.get("/finance/expenses", h((req, res) => res.json(fin.listExpenses({
  from: String(req.query.from || ""), to: String(req.query.to || ""), category: String(req.query.category || ""),
  type: String(req.query.type || ""), includeVoided: req.query.voided === "1"
}))));
const withReceipt = (fn) => (req, res) => receiptUpload(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Receipt is too large (10 MB max)." : "The receipt could not be read." });
  h(fn)(req, res);
});
api.post("/finance/expenses", withReceipt((req, res) => res.status(201).json({ expense: fin.createExpense(req.body, req.file) })));
api.post("/finance/expenses/:id", withReceipt((req, res) => res.json({ expense: fin.updateExpense(id(req), req.body, req.file) })));
api.post("/finance/expenses/:id/void", h((req, res) => res.json({ expense: fin.voidExpense(id(req), !!req.body.voided, req.body.reason) })));
api.get("/expenses/:id/receipt", h((req, res) => {
  const r = fin.getReceipt(id(req));
  res.setHeader("Cache-Control", "private, no-store");
  res.download(r.path, r.name);
}));

api.get("/finance/costs", h((req, res) => res.json(fin.listCostItems())));
api.post("/finance/costs", h((req, res) => res.json(fin.saveCostItems(req.body.items))));
api.post("/finance/costs/add", h((req, res) => res.json(fin.addCostItem(req.body))));
api.post("/finance/costs/:id/delete", h((req, res) => res.json(fin.deleteCostItem(id(req)))));

/* inventory */
api.get("/inventory", h((req, res) => res.json(fin.listInventory())));
api.post("/inventory/add", h((req, res) => res.json(fin.addInventoryItem(req.body))));
api.post("/inventory/:id/delete", h((req, res) => res.json(fin.deleteInventoryItem(id(req)))));
api.post("/inventory/:id/adjust", h((req, res) => res.json(fin.adjustStock(id(req), req.body.delta, req.body.reason))));
api.post("/inventory/:id", h((req, res) => res.json(fin.updateInventoryItem(id(req), req.body))));

/* pricing (sliding scale per layout + delivery charge) */
api.get("/pricing", h((req, res) => res.json(fin.pricingView())));
api.post("/pricing", h((req, res) => res.json(fin.savePricing(req.body))));

/* settings (only whitelisted operational settings; never secrets) */
api.get("/settings", h((req, res) => res.json(fin.settingsView())));
api.post("/settings", h((req, res) => res.json(fin.saveSettings(req.body))));

api.use((req, res) => res.status(404).json({ error: "Not found." }));

module.exports = router;
