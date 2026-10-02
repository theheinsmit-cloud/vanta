const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { DATA_DIR } = require("./config");

const db = new DatabaseSync(path.join(DATA_DIR, "vanta.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// All money is stored as integer cents (ZAR) so totals never drift.
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '',
  layout TEXT NOT NULL, orientation TEXT NOT NULL, arrangement TEXT,
  panels INTEGER NOT NULL,
  delivery_method TEXT NOT NULL DEFAULT 'Courier',
  price_per_panel_cents INTEGER NOT NULL,
  product_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT, payment_reference TEXT, paid_at TEXT,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0, refunded_at TEXT, refund_reason TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  production_started_at TEXT, ready_to_ship_at TEXT, shipped_at TEXT, completed_at TEXT, cancelled_at TEXT,
  courier TEXT, tracking_number TEXT, dispatch_date TEXT,
  cost_snapshot TEXT NOT NULL,
  est_cost_cents INTEGER NOT NULL,
  admin_notes TEXT NOT NULL DEFAULT '',
  stock_deducted INTEGER NOT NULL DEFAULT 0,
  dpi_estimate INTEGER, low_res_confirmed INTEGER NOT NULL DEFAULT 0, rights_confirmed INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,              -- 'original' | 'panel'
  panel_index INTEGER,             -- 1..N in mounting order (left to right, top to bottom)
  panel_label TEXT,
  stored_name TEXT NOT NULL,
  download_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_order ON order_files(order_id);

-- One row per print in an order (a cart). Each print has its own image, layout, crop and copies.
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  item_no INTEGER NOT NULL,        -- 1..N as shown to the customer
  layout TEXT NOT NULL, orientation TEXT NOT NULL, arrangement TEXT,
  panels INTEGER NOT NULL,         -- panels in ONE copy of this print
  qty INTEGER NOT NULL DEFAULT 1,  -- identical copies
  price_per_panel_cents INTEGER NOT NULL,
  line_cents INTEGER NOT NULL,     -- price_per_panel x panels x qty
  dpi_estimate INTEGER, low_res_confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,              -- placed | status | payment | refund | shipping | note | stock | archive
  from_value TEXT, to_value TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  cost_type TEXT NOT NULL,         -- 'business' (startup/overhead) | 'production' (variable)
  amount_cents INTEGER NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  receipt_name TEXT, receipt_stored TEXT,
  created_at TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT, voided_at TEXT
);

CREATE TABLE IF NOT EXISTS cost_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  basis TEXT NOT NULL,             -- 'per_panel' | 'per_order'
  amount_cents INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  qty REAL NOT NULL DEFAULT 0,
  low_threshold REAL NOT NULL DEFAULT 0,
  per_panel REAL NOT NULL DEFAULT 0,
  per_order REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  at TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  order_id INTEGER REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT
);
`);

const DEFAULT_SETTINGS = {
  // Pricing (see site/assets/js/pricing.js): one price per A4 panel, plus a handling charge once per
  // order that customers see as free delivery, minus a volume discount on the panel subtotal.
  price_per_panel_cents: "35000",
  shipping_cents: "10000",      // handling, once per order, never discounted
  // Time-limited special: a lower price per panel until promo_ends_at (ISO). Empty price = no special.
  promo_name: "Launch special",
  promo_price_per_panel_cents: "25000",
  promo_ends_at: "2026-12-31T22:00:00.000Z",   // = 1 Jan 2027 00:00 South African time
  volume_tiers: JSON.stringify([{ minPanels: 5, pct: 5 }, { minPanels: 10, pct: 10 }, { minPanels: 20, pct: 15 }]),
  deduct_stock_on: "in_production",   // in_production | completed | off
  next_order_number: "1001",
  business_name: "VANTA",
  business_legal_name: "",
  business_address: "",
  business_email: "",
  business_phone: "",
  vat_number: "",
  bank_details: "",
  invoice_notes: "Thank you for your order."
};
const seedSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seedSetting.run(k, v);
// Per-layout prices were replaced by one price per panel plus volume discounts.
db.exec("DELETE FROM settings WHERE key IN ('price_single_cents', 'price_duo_cents', 'price_quad_cents')");

// Volume discount applied to each order, frozen when it was placed (product_cents stays the pre-discount panel subtotal).
for (const [col, def] of [["discount_pct", "REAL NOT NULL DEFAULT 0"], ["discount_cents", "INTEGER NOT NULL DEFAULT 0"], ["promo_name", "TEXT"], ["promo_saving_cents", "INTEGER NOT NULL DEFAULT 0"]]) {
  if (!db.prepare("PRAGMA table_info(orders)").all().some((c) => c.name === col)) db.exec("ALTER TABLE orders ADD COLUMN " + col + " " + def);
}

// Known repeatable costs are confirmed; everything else is editable but flagged unconfirmed at R0.
const COST_SEEDS = [
  ["aluminium_panel",   "Aluminium panel",                     "per_panel", 2500, 1, 10, ""],
  ["sublimation_print", "Outsourced sublimation print",        "per_panel", 7500, 1, 20, ""],
  ["magnetic_mount",    "Magnetic mounting pieces",            "per_panel", 1154, 1, 30, ""],
  ["heat_tape",         "Heat tape",                           "per_panel", 0,    0, 40, "Not confirmed yet"],
  ["protective_leaf",   "Protective leaf / sheet",             "per_panel", 0,    0, 50, "Not confirmed yet"],
  ["other_mounting",    "Other mounting components",           "per_panel", 0,    0, 60, "Not confirmed yet"],
  ["labour_wastage",    "Labour & wastage allowance",          "per_panel", 0,    0, 70, "Not confirmed yet"],
  ["packaging",         "Packaging (one setup per order)",     "per_order", 0,    0, 80, "Charged once per order, not per panel"],
  ["courier_cost",      "Courier cost (what we pay)",          "per_order", 0,    0, 90, "Not confirmed yet"]
];
// qty = how many of the item go into one panel (per_panel) or one order (per_order).
if (!db.prepare("PRAGMA table_info(cost_items)").all().some((c) => c.name === "qty")) {
  db.exec("ALTER TABLE cost_items ADD COLUMN qty REAL NOT NULL DEFAULT 1");
}
// Seed only an empty table, so lines the owner removed don't come back on restart.
if (!db.prepare("SELECT COUNT(*) AS n FROM cost_items").get().n) {
  const seedCost = db.prepare("INSERT INTO cost_items (key,label,basis,amount_cents,confirmed,active,sort,note) VALUES (?,?,?,?,?,1,?,?)");
  for (const [key, label, basis, cents, confirmed, sort, note] of COST_SEEDS) seedCost.run(key, label, basis, cents, confirmed, sort, note);
}

const INVENTORY_SEEDS = [
  ["aluminium_blank", "Aluminium blanks (A4)",     "pcs", 0, 10, 1, 0],
  ["magnet_piece",    "Magnetic mounting pieces",  "pcs", 0, 20, 1, 0],
  ["packaging_set",   "Packaging sets",            "sets", 0, 0, 0, 1]
];
// Seed only an empty table, so items the owner removed don't come back on restart.
if (!db.prepare("SELECT COUNT(*) AS n FROM inventory_items").get().n) {
  const seedInv = db.prepare("INSERT INTO inventory_items (key,name,unit,qty,low_threshold,per_panel,per_order) VALUES (?,?,?,?,?,?,?)");
  for (const row of INVENTORY_SEEDS) seedInv.run(...row);
}

// Orders from before the cart held exactly one print: give each its item row and link its files.
if (!db.prepare("PRAGMA table_info(order_files)").all().some((c) => c.name === "item_id")) {
  db.exec("ALTER TABLE order_files ADD COLUMN item_id INTEGER REFERENCES order_items(id)");
}
for (const o of db.prepare("SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM order_items)").all()) {
  const r = db.prepare(`INSERT INTO order_items (order_id, item_no, layout, orientation, arrangement, panels, qty, price_per_panel_cents, line_cents, dpi_estimate, low_res_confirmed)
    VALUES (?,1,?,?,?,?,1,?,?,?,?)`).run(o.id, o.layout, o.orientation, o.arrangement, o.panels, o.price_per_panel_cents, o.product_cents, o.dpi_estimate, o.low_res_confirmed);
  db.prepare("UPDATE order_files SET item_id = ? WHERE order_id = ? AND item_id IS NULL").run(Number(r.lastInsertRowid), o.id);
}

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (e) { /* already rolled back */ }
    throw err;
  }
}

const now = () => new Date().toISOString();

function getSettings() {
  const out = {};
  for (const row of db.prepare("SELECT key, value FROM settings").all()) out[row.key] = row.value;
  return out;
}
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

module.exports = { db, tx, now, getSettings, getSetting, setSetting, DEFAULT_SETTINGS };
