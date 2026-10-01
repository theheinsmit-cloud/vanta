const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, tx, now, getSettings, setSetting } = require("../db");
const { RECEIPT_DIR } = require("../config");
const { EXPENSE_CATEGORIES, EXPENSE_TYPES, STATUSES, STATUS_LABEL } = require("./constants");
const { financials } = require("./orders");
const { rand, toCents, clampStr, slug, saDate, isDateStr, safeFilename, HttpError } = require("./util");

const allOrders = () => db.prepare("SELECT * FROM orders").all();
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

/* ---------------- income (generated from paid orders) ---------------- */
function incomeSummary(from, to) {
  let gross = 0, shipping = 0, refunds = 0, contribution = 0;
  const rows = [];
  for (const o of allOrders()) {
    if (o.paid_cents > 0) {
      const paidDay = saDate(o.paid_at || o.created_at);
      if (inRange(paidDay, from, to)) {
        const ship = Math.min(o.shipping_cents, o.paid_cents);
        shipping += ship;
        gross += o.paid_cents - ship;
        const f = financials(o);
        contribution += f.contribution;
        rows.push({
          id: o.id, orderNumber: o.order_number, paidAt: o.paid_at || o.created_at,
          customer: o.first_name + " " + o.last_name,
          product: rand(o.paid_cents - ship), shipping: rand(ship), refunded: rand(o.refunded_cents), net: rand(f.net)
        });
      }
    }
    if (o.refunded_cents > 0 && inRange(saDate(o.refunded_at || o.created_at), from, to)) refunds += o.refunded_cents;
  }
  rows.sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1));
  return {
    grossSales: rand(gross), shippingIncome: rand(shipping), refunds: rand(refunds),
    netSales: rand(gross + shipping - refunds), estimatedContribution: rand(contribution),
    orderCount: rows.length, rows
  };
}

/* ---------------- expenses ---------------- */
function expenseView(e) {
  return {
    id: e.id, date: e.date, description: e.description, category: e.category, costType: e.cost_type,
    amount: rand(e.amount_cents), supplier: e.supplier, notes: e.notes,
    receipt: e.receipt_stored ? { name: e.receipt_name, url: "/admin/api/expenses/" + e.id + "/receipt" } : null,
    voided: !!e.voided, voidReason: e.void_reason, voidedAt: e.voided_at, createdAt: e.created_at
  };
}

function expenseTotals(from, to) {
  const t = { business: 0, production: 0, byCategory: {} };
  for (const e of db.prepare("SELECT * FROM expenses WHERE voided = 0").all()) {
    if (!inRange(e.date, from, to)) continue;
    t[e.cost_type] += e.amount_cents;
    t.byCategory[e.category] = (t.byCategory[e.category] || 0) + e.amount_cents;
  }
  return {
    business: rand(t.business), production: rand(t.production), total: rand(t.business + t.production),
    byCategory: Object.fromEntries(Object.entries(t.byCategory).map(([k, v]) => [k, rand(v)]))
  };
}

function listExpenses({ from, to, category, type, includeVoided } = {}) {
  const rows = db.prepare("SELECT * FROM expenses ORDER BY date DESC, id DESC").all()
    .filter((e) => (includeVoided || !e.voided) && inRange(e.date, from, to) && (!category || e.category === category) && (!type || e.cost_type === type));
  return { expenses: rows.map(expenseView), totals: expenseTotals(from, to) };
}

function cleanExpense(f) {
  const date = String(f.date || "");
  if (!isDateStr(date)) throw new HttpError(400, "Please enter a valid date.");
  const description = clampStr(f.description, 200);
  if (!description) throw new HttpError(400, "Please enter a description.");
  if (!EXPENSE_CATEGORIES.includes(f.category)) throw new HttpError(400, "Please choose a category.");
  if (!EXPENSE_TYPES.includes(f.costType)) throw new HttpError(400, "Please choose business or production cost.");
  const cents = toCents(f.amount);
  if (cents == null || cents <= 0) throw new HttpError(400, "Please enter an amount above zero.");
  return { date, description, category: f.category, costType: f.costType, cents, supplier: clampStr(f.supplier, 120), notes: clampStr(f.notes, 1000) };
}

function saveReceipt(file) {
  if (!file) return null;
  const b = file.buffer;
  const isPdf = b.length > 4 && b.slice(0, 4).toString() === "%PDF";
  const isPng = b.length > 4 && b[0] === 0x89 && b[1] === 0x50;
  const isJpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
  if (!isPdf && !isPng && !isJpg) throw new HttpError(400, "Receipts must be a PDF, JPG or PNG.");
  const stored = crypto.randomBytes(16).toString("hex") + (isPdf ? ".pdf" : isPng ? ".png" : ".jpg");
  fs.writeFileSync(path.join(RECEIPT_DIR, stored), b);
  return { stored, name: safeFilename(file.originalname, "receipt") };
}

function createExpense(f, file) {
  const c = cleanExpense(f);
  const receipt = saveReceipt(file);
  const res = db.prepare(`INSERT INTO expenses (date, description, category, cost_type, amount_cents, supplier, notes, receipt_name, receipt_stored, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(c.date, c.description, c.category, c.costType, c.cents, c.supplier, c.notes,
    receipt ? receipt.name : null, receipt ? receipt.stored : null, now());
  return expenseView(db.prepare("SELECT * FROM expenses WHERE id = ?").get(Number(res.lastInsertRowid)));
}

function updateExpense(id, f, file) {
  const existing = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!existing) throw new HttpError(404, "Expense not found.");
  const c = cleanExpense(f);
  const receipt = saveReceipt(file);
  db.prepare(`UPDATE expenses SET date=?, description=?, category=?, cost_type=?, amount_cents=?, supplier=?, notes=?,
    receipt_name=COALESCE(?, receipt_name), receipt_stored=COALESCE(?, receipt_stored) WHERE id=?`)
    .run(c.date, c.description, c.category, c.costType, c.cents, c.supplier, c.notes, receipt ? receipt.name : null, receipt ? receipt.stored : null, id);
  return expenseView(db.prepare("SELECT * FROM expenses WHERE id = ?").get(id));
}

function voidExpense(id, voided, reason) {
  const e = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!e) throw new HttpError(404, "Expense not found.");
  db.prepare("UPDATE expenses SET voided=?, void_reason=?, voided_at=? WHERE id=?")
    .run(voided ? 1 : 0, voided ? clampStr(reason, 300) || null : null, voided ? now() : null, id);
  return expenseView(db.prepare("SELECT * FROM expenses WHERE id = ?").get(id));
}

function getReceipt(id) {
  const e = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!e || !e.receipt_stored) throw new HttpError(404, "Receipt not found.");
  const full = path.join(RECEIPT_DIR, e.receipt_stored);
  if (!full.startsWith(RECEIPT_DIR + path.sep) || !fs.existsSync(full)) throw new HttpError(404, "Receipt not found.");
  return { path: full, name: e.receipt_name || e.receipt_stored };
}

/* ---------------- unit costs ---------------- */
function costItemView(i) {
  return { id: i.id, key: i.key, label: i.label, basis: i.basis, amount: rand(i.amount_cents), confirmed: !!i.confirmed, active: !!i.active, note: i.note };
}
function listCostItems() {
  const items = db.prepare("SELECT * FROM cost_items ORDER BY sort, id").all();
  const example = (panels) => rand(items.filter((i) => i.active).reduce((s, i) => s + i.amount_cents * (i.basis === "per_panel" ? panels : 1), 0));
  return { items: items.map(costItemView), examples: { 1: example(1), 2: example(2), 4: example(4) } };
}
function saveCostItems(list) {
  if (!Array.isArray(list)) throw new HttpError(400, "Invalid cost list.");
  return tx(() => {
    const upd = db.prepare("UPDATE cost_items SET label=?, basis=?, amount_cents=?, confirmed=?, active=?, note=? WHERE id=?");
    for (const i of list) {
      const cents = toCents(i.amount);
      if (cents == null || cents < 0) throw new HttpError(400, "Every cost must be zero or more.");
      if (!["per_panel", "per_order"].includes(i.basis)) throw new HttpError(400, "Invalid cost basis.");
      const label = clampStr(i.label, 80);
      if (!label) throw new HttpError(400, "Every cost needs a name.");
      upd.run(label, i.basis, cents, i.confirmed ? 1 : 0, i.active ? 1 : 0, clampStr(i.note, 200), Number(i.id));
    }
    return listCostItems();
  });
}
function addCostItem(f) {
  const label = clampStr(f.label, 80);
  if (!label) throw new HttpError(400, "Please name the cost.");
  if (!["per_panel", "per_order"].includes(f.basis)) throw new HttpError(400, "Invalid cost basis.");
  const cents = toCents(f.amount) || 0;
  if (cents < 0) throw new HttpError(400, "Cost must be zero or more.");
  let key = slug(label) || "cost", n = 1;
  while (db.prepare("SELECT 1 FROM cost_items WHERE key = ?").get(key)) key = slug(label) + "-" + ++n;
  const sort = (db.prepare("SELECT COALESCE(MAX(sort),0) AS m FROM cost_items").get().m || 0) + 10;
  db.prepare("INSERT INTO cost_items (key,label,basis,amount_cents,confirmed,active,sort,note) VALUES (?,?,?,?,?,1,?,?)")
    .run(key, label, f.basis, cents, f.confirmed ? 1 : 0, sort, "");
  return listCostItems();
}

/* ---------------- inventory ---------------- */
function inventoryView(i) {
  return { id: i.id, key: i.key, name: i.name, unit: i.unit, qty: i.qty, lowThreshold: i.low_threshold, perPanel: i.per_panel, perOrder: i.per_order, low: i.low_threshold > 0 && i.qty <= i.low_threshold };
}
function listInventory() {
  const items = db.prepare("SELECT * FROM inventory_items ORDER BY id").all().map(inventoryView);
  const movements = db.prepare(`SELECT m.*, i.name AS item_name, o.order_number FROM stock_movements m
    JOIN inventory_items i ON i.id = m.item_id LEFT JOIN orders o ON o.id = m.order_id ORDER BY m.id DESC LIMIT 40`).all()
    .map((m) => ({ at: m.at, item: m.item_name, delta: m.delta, reason: m.reason, orderNumber: m.order_number }));
  return { items, movements };
}
function adjustStock(id, delta, reason) {
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) throw new HttpError(400, "Enter a quantity to add or remove.");
  return tx(() => {
    const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(id);
    if (!item) throw new HttpError(404, "Item not found.");
    db.prepare("UPDATE inventory_items SET qty = qty + ? WHERE id = ?").run(d, id);
    db.prepare("INSERT INTO stock_movements (item_id, at, delta, reason) VALUES (?,?,?,?)").run(id, now(), d, clampStr(reason, 200) || (d > 0 ? "Stock added" : "Stock removed"));
    return listInventory();
  });
}
function updateInventoryItem(id, f) {
  const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(id);
  if (!item) throw new HttpError(404, "Item not found.");
  const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fallback; };
  db.prepare("UPDATE inventory_items SET name=?, low_threshold=?, per_panel=?, per_order=? WHERE id=?")
    .run(clampStr(f.name, 80) || item.name, num(f.lowThreshold, item.low_threshold), num(f.perPanel, item.per_panel), num(f.perOrder, item.per_order), id);
  return listInventory();
}

/* ---------------- settings ---------------- */
const TEXT_SETTINGS = { business_name: 80, business_legal_name: 120, business_address: 300, business_email: 120, business_phone: 40, vat_number: 40, bank_details: 500, invoice_notes: 500 };

function settingsView() {
  const s = getSettings();
  const out = {
    pricePerPanel: rand(parseInt(s.price_per_panel_cents, 10)),
    shipping: rand(parseInt(s.shipping_cents, 10)),
    deductStockOn: s.deduct_stock_on
  };
  for (const k of Object.keys(TEXT_SETTINGS)) out[k] = s[k] || "";
  return out;
}
function saveSettings(f) {
  return tx(() => {
    const price = toCents(f.pricePerPanel), ship = toCents(f.shipping);
    if (price == null || price <= 0) throw new HttpError(400, "Price per panel must be above zero.");
    if (ship == null || ship < 0) throw new HttpError(400, "Shipping must be zero or more.");
    if (!["in_production", "completed", "off"].includes(f.deductStockOn)) throw new HttpError(400, "Invalid stock deduction setting.");
    setSetting("price_per_panel_cents", price);
    setSetting("shipping_cents", ship);
    setSetting("deduct_stock_on", f.deductStockOn);
    for (const [k, max] of Object.entries(TEXT_SETTINGS)) if (k in f) setSetting(k, clampStr(f[k], max));
    return settingsView();
  });
}

/* ---------------- dashboard ---------------- */
function monthRange() {
  const today = saDate();
  const start = today.slice(0, 8) + "01";
  return { from: start, to: today.slice(0, 8) + "31" };
}

function dashboard() {
  const orders = allOrders();
  const counts = Object.fromEntries(STATUSES.map((s) => [s.key, 0]));
  for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;

  const m = monthRange();
  const inc = incomeSummary(), incMonth = incomeSummary(m.from, m.to);
  const exp = expenseTotals(), expMonth = expenseTotals(m.from, m.to);

  const live = orders.filter((o) => !o.archived);
  const section = (key, title, list, sub) => ({
    key, title, count: list.length,
    items: list.slice(0, 6).map((o) => ({ id: o.id, label: o.order_number + " · " + o.first_name + " " + o.last_name, sub: sub(o) }))
  });
  const byStatus = (s) => live.filter((o) => o.status === s).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const attention = [
    section("new", "New orders", byStatus("new"), (o) => o.payment_status === "pending" ? "Awaiting payment" : "Paid"),
    section("artwork_check", "Artwork check", byStatus("artwork_check"), (o) => o.low_res_confirmed ? "Customer accepted low resolution" : "Check artwork"),
    section("ready_for_production", "Ready for production", byStatus("ready_for_production"), (o) => o.panels + " panel" + (o.panels > 1 ? "s" : "")),
    section("ready_to_ship", "Ready to ship", byStatus("ready_to_ship"), (o) => o.city),
    section("unpaid", "Awaiting payment", live.filter((o) => o.payment_status === "pending" && !["new", "cancelled", "refunded"].includes(o.status)), (o) => STATUS_LABEL[o.status])
  ].filter((s) => s.count > 0);
  const low = listInventory().items.filter((i) => i.low);
  if (low.length) {
    attention.push({ key: "stock", title: "Low stock", count: low.length, link: "#/inventory", items: low.map((i) => ({ id: null, label: i.name, sub: i.qty + " left" })) });
  }

  const period = (income, expenses) => ({
    netSales: income.netSales, expenses: expenses.total, contribution: income.estimatedContribution,
    profit: Math.round((income.netSales - expenses.total) * 100) / 100
  });
  return {
    counts,
    allTime: period(inc, exp),
    thisMonth: period(incMonth, expMonth),
    income: { gross: inc.grossSales, shipping: inc.shippingIncome, refunds: inc.refunds },
    expenseSplit: { business: exp.business, production: exp.production },
    attention
  };
}

module.exports = {
  incomeSummary, listExpenses, expenseTotals, createExpense, updateExpense, voidExpense, getReceipt,
  listCostItems, saveCostItems, addCostItem, listInventory, adjustStock, updateInventoryItem,
  settingsView, saveSettings, dashboard, EXPENSE_CATEGORIES, EXPENSE_TYPES
};
