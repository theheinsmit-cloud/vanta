const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { db, tx, now, getSetting, setSetting } = require("../db");
const { UPLOAD_DIR } = require("../config");
const { STATUS_KEYS, STATUS_LABEL, PIPELINE, LAYOUT_PANELS, LAYOUT_LABEL, PRICED_LAYOUTS, PAYMENT_LABEL } = require("./constants");
const { quote, cleanTiers } = require("../../site/assets/js/pricing");
const { rand, clampStr, slug, safeFilename, saDate, isDateStr, HttpError } = require("./util");

/* ---------------- images ---------------- */
function imageInfo(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2, width = null, height = null;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
    return { mime: "image/jpeg", ext: "jpg", width, height };
  }
  return null;
}

/* ---------------- pricing & cost snapshot ---------------- */
// Current pricing config, in the shape pricing.js expects. shipping_cents holds the per-order handling charge.
function getPricing() {
  let tiers = [];
  try { tiers = cleanTiers(JSON.parse(getSetting("volume_tiers") || "[]")); } catch (e) { tiers = []; }
  return {
    pricePerPanelCents: parseInt(getSetting("price_per_panel_cents"), 10),
    handlingCents: parseInt(getSetting("shipping_cents"), 10),
    tiers,
    promo: { name: getSetting("promo_name") || "Special", pricePerPanelCents: parseInt(getSetting("promo_price_per_panel_cents"), 10) || 0, endsAt: getSetting("promo_ends_at") || "" }
  };
}

// Freezes the unit costs that apply right now. Later price changes never touch stored orders.
function buildCostSnapshot(panels) {
  const items = db.prepare("SELECT * FROM cost_items ORDER BY sort, id").all();
  const lines = items.map((i) => {
    const quantity = i.qty * (i.basis === "per_panel" ? panels : 1);
    return {
      key: i.key, label: i.label, basis: i.basis, unitCents: i.amount_cents,
      quantity, totalCents: Math.round(i.amount_cents * quantity)
    };
  });
  return { takenAt: now(), panels, lines, totalCents: lines.reduce((s, l) => s + l.totalCents, 0) };
}

/* ---------------- events ---------------- */
function addEvent(orderId, type, from, to, detail) {
  db.prepare("INSERT INTO order_events (order_id, at, type, from_value, to_value, detail) VALUES (?,?,?,?,?,?)")
    .run(orderId, now(), type, from == null ? null : String(from), to == null ? null : String(to), detail || null);
}

/* ---------------- create (public checkout) ---------------- */
const MAX_ITEMS = 10, MAX_QTY = 20;

// f = customer details; items = [{ layout, orientation, arrangement, qty, dpi, lowResConfirmed, original, panels }]
// Each item is one print (one image, one crop); qty is identical copies of it.
// opts.checkout: an online-payment checkout. It gets a private CHK- reference, stays hidden from the admin
// and only becomes a real, numbered order in promoteCheckout() once the payment is confirmed.
function createOrder(f, items, opts = {}) {
  const first = clampStr(f.firstName, 80), last = clampStr(f.lastName, 80);
  const email = clampStr(f.email, 160).toLowerCase();
  if (!first || !last) throw new HttpError(400, "Please enter your first and last name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  const phone = clampStr(f.phone, 40), address = clampStr(f.address, 200), city = clampStr(f.city, 80), postal = clampStr(f.postal, 20);
  if (!phone || !address || !city || !postal) throw new HttpError(400, "Please complete your delivery details.");
  if (!f.rightsConfirmed) throw new HttpError(400, "Please confirm you have the right to print these images.");

  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Your order has no prints in it.");
  if (items.length > MAX_ITEMS) throw new HttpError(400, "An order can hold up to " + MAX_ITEMS + " different prints.");

  // Prices are always recalculated here from the Pricing page, never taken from the browser.
  const pricing = getPricing();
  const placedMs = Date.now();   // decides whether a time-limited special applies
  const lines = items.map((it, i) => {
    const layout = String(it.layout || "");
    const panels = LAYOUT_PANELS[layout];
    const label = "Print " + (i + 1);
    if (!panels || !PRICED_LAYOUTS.includes(layout)) throw new HttpError(400, label + ": unknown layout.");
    if (!["portrait", "landscape"].includes(it.orientation)) throw new HttpError(400, label + ": unknown orientation.");
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, label + ": quantity must be between 1 and " + MAX_QTY + ".");
    if (!it.original) throw new HttpError(400, label + ": the original image is missing.");
    if (!Array.isArray(it.panels) || it.panels.length !== panels) throw new HttpError(400, label + ": the number of print files doesn't match the layout.");
    return {
      ...it, panelFiles: it.panels, layout, panels, qty,
      arrangement: layout === "duo" && ["side", "stacked"].includes(it.arrangement) ? it.arrangement : null,
      dpi: Number.isFinite(it.dpi) ? Math.max(0, Math.min(2000, Math.round(it.dpi))) : null
    };
  });

  // Volume discount comes from the total physical panels: every copy of every print counts.
  const totalPanels = lines.reduce((s, l) => s + l.panels * l.qty, 0);
  const q = quote(totalPanels, pricing, placedMs);
  const pricePerPanelCents = q.pricePerPanelCents;
  for (const l of lines) { l.pricePerPanelCents = pricePerPanelCents; l.lineCents = pricePerPanelCents * l.panels * l.qty; }
  // The browser sends the total it showed; if prices changed meanwhile, stop rather than charge a surprise amount.
  if (f.expectedTotalCents != null && Number(f.expectedTotalCents) !== q.totalCents) {
    throw new HttpError(409, "Our prices have just been updated. Please check your new order total and place the order again.");
  }
  const snapshot = buildCostSnapshot(totalPanels);
  const dpis = lines.map((l) => l.dpi).filter((d) => d != null);
  const one = lines.length === 1 ? lines[0] : null;
  const placedAt = now();

  return tx(() => {
    let orderNumber;
    if (opts.checkout) orderNumber = "CHK-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    else {
      const n = parseInt(getSetting("next_order_number"), 10);
      setSetting("next_order_number", n + 1);
      orderNumber = "VNT-" + n;
    }

    // Order-level layout columns summarise the cart: "mixed" when it holds more than one print.
    const res = db.prepare(`INSERT INTO orders
      (order_number, created_at, first_name, last_name, email, phone, address, city, postal_code,
       layout, orientation, arrangement, panels, delivery_method,
       price_per_panel_cents, product_cents, discount_pct, discount_cents, promo_name, promo_saving_cents, shipping_cents, total_cents,
       cost_snapshot, est_cost_cents, dpi_estimate, low_res_confirmed, rights_confirmed, awaiting_payment)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNumber, placedAt, first, last, email, phone, address, city, postal,
        one ? one.layout : "mixed", one ? one.orientation : "mixed", one ? one.arrangement : null, totalPanels, "Courier",
        pricePerPanelCents, q.baseCents, q.discountPct, q.discountCents, q.promo ? q.promo.name : null, q.promoSavingCents, q.handlingCents, q.totalCents,
        JSON.stringify(snapshot), snapshot.totalCents, dpis.length ? Math.min(...dpis) : null, lines.some((l) => l.lowResConfirmed) ? 1 : 0, 1, opts.checkout ? 1 : 0);
    const id = Number(res.lastInsertRowid);

    const dir = path.join(UPLOAD_DIR, orderNumber);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const insertItem = db.prepare(`INSERT INTO order_items
        (order_id, item_no, layout, orientation, arrangement, panels, qty, price_per_panel_cents, line_cents, dpi_estimate, low_res_confirmed)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const insertFile = db.prepare(`INSERT INTO order_files
        (order_id, item_id, kind, panel_index, panel_label, stored_name, download_name, mime, size, width, height, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

      lines.forEach((l, i) => {
        const no = i + 1, tag = "p" + no;
        const itemId = Number(insertItem.run(id, no, l.layout, l.orientation, l.arrangement, l.panels, l.qty,
          l.pricePerPanelCents, l.lineCents, l.dpi, l.lowResConfirmed ? 1 : 0).lastInsertRowid);

        const o = l.original;
        const originalStored = tag + "-original." + o.info.ext;
        fs.writeFileSync(path.join(dir, originalStored), o.buffer);
        insertFile.run(id, itemId, "original", null, null, originalStored, orderNumber + "-" + tag + "-original-" + safeFilename(o.name, "image." + o.info.ext),
          o.info.mime, o.buffer.length, o.info.width, o.info.height, placedAt);

        l.panelFiles.forEach((p) => {
          const stored = tag + "-panel-" + String(p.index).padStart(2, "0") + "." + p.info.ext;
          fs.writeFileSync(path.join(dir, stored), p.buffer);
          const dl = orderNumber + "-" + tag + "-panel-" + p.index + "of" + l.panels + (p.label ? "-" + slug(p.label) : "") + (l.qty > 1 ? "-x" + l.qty : "") + "." + p.info.ext;
          insertFile.run(id, itemId, "panel", p.index, p.label || null, stored, dl, p.info.mime, p.buffer.length, p.info.width, p.info.height, placedAt);
        });
      });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    addEvent(id, opts.checkout ? "checkout" : "placed", null, opts.checkout ? null : "new", (opts.checkout ? "Checkout started on the website" : "Order placed on the website") + (lines.length > 1 ? " (" + lines.length + " prints)" : ""));
    return { id, orderNumber };
  });
}

/* ---------------- checkouts (online payment) ---------------- */
// A paid checkout becomes a real order: next VNT number, files renamed to match, placed now.
function promoteCheckout(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o || !o.awaiting_payment) return o;
  return tx(() => {
    const n = parseInt(getSetting("next_order_number"), 10);
    setSetting("next_order_number", n + 1);
    const number = "VNT-" + n;
    const from = path.join(UPLOAD_DIR, o.order_number), to = path.join(UPLOAD_DIR, number);
    if (fs.existsSync(from)) fs.renameSync(from, to);
    try {
      db.prepare("UPDATE orders SET order_number = ?, awaiting_payment = 0, created_at = ? WHERE id = ?").run(number, now(), id);
      db.prepare("UPDATE order_files SET download_name = replace(download_name, ?, ?) WHERE order_id = ?").run(o.order_number, number, id);
      addEvent(id, "placed", null, "new", "Order placed on the website, paid online (checkout " + o.order_number + ")");
    } catch (err) {
      if (fs.existsSync(to)) fs.renameSync(to, from);
      throw err;
    }
    return db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  });
}

// Checkouts that were never paid are deleted (with their images) after a week.
function cleanupCheckouts(days = 7) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const old = db.prepare("SELECT id, order_number FROM orders WHERE awaiting_payment = 1 AND created_at < ?").all(cutoff);
  for (const o of old) {
    tx(() => {
      for (const t of ["order_files", "order_items", "order_paylinks", "order_events"]) db.prepare("DELETE FROM " + t + " WHERE order_id = ?").run(o.id);
      db.prepare("DELETE FROM orders WHERE id = ?").run(o.id);
    });
    fs.rmSync(path.join(UPLOAD_DIR, o.order_number), { recursive: true, force: true });
  }
  if (old.length) console.log("Removed " + old.length + " unpaid checkout(s) older than " + days + " days");
  return old.length;
}

/* ---------------- money maths ---------------- */
// Estimated cost only counts once production has started, unless the order is still live
// (an active order's cost is an expectation; a cancelled one never incurred it).
function financials(o) {
  const paid = o.paid_cents, refunded = o.refunded_cents;
  const net = paid - refunded;
  const inactive = o.status === "cancelled" || o.status === "refunded";
  const costCounted = inactive ? !!o.production_started_at : true;
  const cost = costCounted ? o.est_cost_cents : 0;
  return { paid, refunded, net, cost, costCounted, contribution: paid > 0 ? net - cost : null };
}

function deliveryStatus(o) {
  if (o.status === "cancelled") return "Cancelled";
  if (o.status === "refunded") return "Refunded";
  if (o.status === "completed") return "Delivered";
  if (o.status === "shipped") return "In transit";
  if (o.status === "ready_to_ship") return "Awaiting dispatch";
  return "Not yet dispatched";
}

function itemView(i) {
  return {
    id: i.id, no: i.item_no, layout: i.layout, layoutLabel: LAYOUT_LABEL[i.layout] || i.layout,
    orientation: i.orientation, arrangement: i.arrangement, panels: i.panels, qty: i.qty,
    pricePerPanel: rand(i.price_per_panel_cents), line: rand(i.line_cents),
    dpiEstimate: i.dpi_estimate, lowResConfirmed: !!i.low_res_confirmed
  };
}
const itemsFor = (orderId) => db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY item_no").all(orderId).map(itemView);

function orderView(o) {
  const f = financials(o);
  const items = itemsFor(o.id);
  return {
    id: o.id,
    orderNumber: o.order_number,
    createdAt: o.created_at,
    customer: {
      firstName: o.first_name, lastName: o.last_name, name: o.first_name + " " + o.last_name,
      email: o.email, phone: o.phone, address: o.address, city: o.city, postalCode: o.postal_code
    },
    layout: o.layout, layoutLabel: LAYOUT_LABEL[o.layout] || o.layout,
    orientation: o.orientation, arrangement: o.arrangement, panels: o.panels, items,
    deliveryMethod: o.delivery_method, deliveryStatus: deliveryStatus(o),
    money: {
      pricePerPanel: rand(o.price_per_panel_cents), product: rand(o.product_cents), shipping: rand(o.shipping_cents),
      discountPct: o.discount_pct, discount: rand(o.discount_cents), discountedProduct: rand(o.product_cents - o.discount_cents),
      promoName: o.promo_name, promoSaving: rand(o.promo_saving_cents), regularPricePerPanel: rand(o.price_per_panel_cents + (o.panels ? o.promo_saving_cents / o.panels : 0)),
      total: rand(o.total_cents), paid: rand(f.paid), refunded: rand(f.refunded), net: rand(f.net),
      estCost: rand(o.est_cost_cents), costCounted: f.costCounted,
      contribution: f.contribution == null ? null : rand(f.contribution)
    },
    payment: {
      status: o.payment_status, statusLabel: PAYMENT_LABEL[o.payment_status] || o.payment_status,
      method: o.payment_method, reference: o.payment_reference, paidAt: o.paid_at,
      refundedAt: o.refunded_at, refundReason: o.refund_reason
    },
    status: o.status, statusLabel: STATUS_LABEL[o.status] || o.status,
    timestamps: {
      placed: o.created_at, productionStarted: o.production_started_at, readyToShip: o.ready_to_ship_at,
      shipped: o.shipped_at, completed: o.completed_at, cancelled: o.cancelled_at
    },
    shipping: { courier: o.courier, trackingNumber: o.tracking_number, dispatchDate: o.dispatch_date },
    adminNotes: o.admin_notes,
    archived: !!o.archived,
    stockDeducted: !!o.stock_deducted,
    artwork: { dpiEstimate: o.dpi_estimate, lowResConfirmed: !!o.low_res_confirmed, rightsConfirmed: !!o.rights_confirmed }
  };
}

/* ---------------- queries ---------------- */
// Admin-visible orders only: unpaid checkouts don't exist as far as the admin is concerned.
function getRow(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND awaiting_payment = 0").get(id);
  if (!o) throw new HttpError(404, "Order not found.");
  return o;
}

function listOrders({ q, status, payment, archived } = {}) {
  const where = [], params = [];
  where.push("awaiting_payment = 0");
  if (archived === "1") where.push("archived = 1");
  else if (archived !== "all") where.push("archived = 0");
  if (status && STATUS_KEYS.includes(status)) { where.push("status = ?"); params.push(status); }
  if (payment) { where.push("payment_status = ?"); params.push(payment); }
  if (q && q.trim()) {
    const like = "%" + q.trim().replace(/[%_]/g, "") + "%";
    where.push("(order_number LIKE ? OR first_name || ' ' || last_name LIKE ? OR email LIKE ? OR phone LIKE ?)");
    params.push(like, like, like, like);
  }
  const sql = "SELECT * FROM orders" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC, id DESC LIMIT 500";
  return db.prepare(sql).all(...params).map(orderView);
}

function fileView(orderId, f) {
  return {
    id: f.id, itemId: f.item_id, kind: f.kind, panelIndex: f.panel_index, label: f.panel_label,
    downloadName: f.download_name, mime: f.mime, size: f.size, width: f.width, height: f.height,
    url: "/admin/api/orders/" + orderId + "/files/" + f.id
  };
}

function getOrderDetail(id) {
  const o = getRow(id);
  const files = db.prepare("SELECT * FROM order_files WHERE order_id = ? ORDER BY kind DESC, panel_index").all(id).map((f) => fileView(id, f));
  const events = db.prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY id").all(id)
    .map((e) => ({ at: e.at, type: e.type, from: e.from_value, to: e.to_value, detail: e.detail }));
  const others = db.prepare("SELECT id, order_number, created_at, status, total_cents FROM orders WHERE email = ? AND id != ? AND awaiting_payment = 0 ORDER BY created_at DESC").all(o.email, id)
    .map((x) => ({ id: x.id, orderNumber: x.order_number, createdAt: x.created_at, status: x.status, statusLabel: STATUS_LABEL[x.status], total: rand(x.total_cents) }));
  const snapshot = JSON.parse(o.cost_snapshot);
  return {
    order: orderView(o), files, events, otherOrders: others,
    paylinks: db.prepare("SELECT paylink_id, external_id, amount_cents, created_at FROM order_paylinks WHERE order_id = ? ORDER BY id").all(id)
      .map((l) => ({ paylinkId: l.paylink_id, reference: l.external_id, amount: rand(l.amount_cents), createdAt: l.created_at })),
    costSnapshot: {
      takenAt: snapshot.takenAt, total: rand(snapshot.totalCents),
      lines: snapshot.lines.map((l) => ({ label: l.label, basis: l.basis, unit: rand(l.unitCents), quantity: l.quantity, total: rand(l.totalCents) }))
    }
  };
}

function getOrderFile(orderId, fileId) {
  const f = db.prepare("SELECT f.*, o.order_number FROM order_files f JOIN orders o ON o.id = f.order_id WHERE f.id = ? AND f.order_id = ?").get(fileId, orderId);
  if (!f) throw new HttpError(404, "File not found.");
  const full = path.join(UPLOAD_DIR, f.order_number, f.stored_name);
  if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) throw new HttpError(404, "File not found.");
  return { path: full, downloadName: f.download_name, mime: f.mime };
}

function customerOrders(email) {
  const rows = db.prepare("SELECT * FROM orders WHERE email = ? AND awaiting_payment = 0 ORDER BY created_at DESC").all(String(email).toLowerCase());
  return rows.map(orderView);
}

/* ---------------- mutations ---------------- */
function deductStock(o) {
  const items = db.prepare("SELECT * FROM inventory_items").all();
  const upd = db.prepare("UPDATE inventory_items SET qty = qty - ? WHERE id = ?");
  const mov = db.prepare("INSERT INTO stock_movements (item_id, at, delta, reason, order_id) VALUES (?,?,?,?,?)");
  for (const item of items) {
    const need = item.per_panel * o.panels + item.per_order;
    if (need <= 0) continue;
    upd.run(need, item.id);
    mov.run(item.id, now(), -need, "Used for " + o.order_number, o.id);
  }
  db.prepare("UPDATE orders SET stock_deducted = 1 WHERE id = ?").run(o.id);
  addEvent(o.id, "stock", null, null, "Stock deducted for this order");
}

const STAGE_COLUMN = { in_production: "production_started_at", ready_to_ship: "ready_to_ship_at", shipped: "shipped_at", completed: "completed_at" };

function cleanShipping(s = {}) {
  const dispatch = s.dispatchDate ? String(s.dispatchDate) : "";
  if (dispatch && !isDateStr(dispatch)) throw new HttpError(400, "Dispatch date must be a valid date.");
  return { courier: clampStr(s.courier, 80), tracking: clampStr(s.trackingNumber, 80), dispatch };
}

function changeStatus(id, to, { note, shipping } = {}) {
  if (!STATUS_KEYS.includes(to)) throw new HttpError(400, "Unknown status.");
  if (to === "refunded") throw new HttpError(400, "Record the refund in the Payment section. It sets this status automatically.");
  const ship = to === "shipped" && shipping ? cleanShipping(shipping) : null;

  return tx(() => {
    const o = getRow(id);
    if (o.status === to) return orderView(o);
    const t = now();
    const sets = ["status = ?"], params = [to];

    if (STAGE_COLUMN[to] && (to !== "in_production" || !o.production_started_at)) { sets.push(STAGE_COLUMN[to] + " = ?"); params.push(t); }
    if (to === "cancelled") { sets.push("cancelled_at = ?"); params.push(t); }
    if (to === "shipped") {
      const s = ship || { courier: "", tracking: "", dispatch: "" };
      sets.push("courier = COALESCE(NULLIF(?, ''), courier)", "tracking_number = COALESCE(NULLIF(?, ''), tracking_number)", "dispatch_date = ?");
      params.push(s.courier, s.tracking, s.dispatch || o.dispatch_date || saDate());
    }
    // Moving back down the pipeline clears the later stage timestamps; the event log keeps the true history.
    if (PIPELINE.includes(to)) {
      const idx = PIPELINE.indexOf(to);
      for (const [stage, col] of Object.entries(STAGE_COLUMN)) {
        if (PIPELINE.indexOf(stage) > idx) sets.push(col + " = NULL");
      }
      if (o.status === "cancelled") sets.push("cancelled_at = NULL");
    }
    db.prepare("UPDATE orders SET " + sets.join(", ") + " WHERE id = ?").run(...params, id);
    addEvent(id, "status", o.status, to, clampStr(note, 300));

    const trigger = getSetting("deduct_stock_on");
    if (trigger !== "off" && !o.stock_deducted && PIPELINE.includes(to) && PIPELINE.indexOf(to) >= PIPELINE.indexOf(trigger)) {
      deductStock(o);
    }
    return orderView(getRow(id));
  });
}

function markPaid(id, { amountCents, method, reference, date }) {
  return tx(() => {
    const o = getRow(id);
    if (o.payment_status !== "pending") throw new HttpError(400, "This order already has a payment recorded.");
    const amount = amountCents == null ? o.total_cents : amountCents;
    if (!(amount > 0)) throw new HttpError(400, "Payment amount must be more than zero.");
    if (date && !isDateStr(date)) throw new HttpError(400, "Payment date must be a valid date.");
    const paidAt = date ? new Date(date + "T12:00:00+02:00").toISOString() : now();
    db.prepare("UPDATE orders SET payment_status='paid', paid_cents=?, paid_at=?, payment_method=?, payment_reference=? WHERE id=?")
      .run(amount, paidAt, clampStr(method, 60) || null, clampStr(reference, 120) || null, id);
    addEvent(id, "payment", "pending", "paid", "R" + rand(amount).toFixed(2) + (method ? " via " + clampStr(method, 60) : ""));
    return orderView(getRow(id));
  });
}

function markUnpaid(id) {
  return tx(() => {
    const o = getRow(id);
    if (o.payment_status !== "paid" || o.refunded_cents > 0) throw new HttpError(400, "Only a paid order with no refunds can be reverted.");
    db.prepare("UPDATE orders SET payment_status='pending', paid_cents=0, paid_at=NULL, payment_method=NULL, payment_reference=NULL WHERE id=?").run(id);
    addEvent(id, "payment", "paid", "pending", "Payment marked as not received");
    return orderView(getRow(id));
  });
}

function recordRefund(id, { amountCents, reason }) {
  return tx(() => {
    const o = getRow(id);
    const remaining = o.paid_cents - o.refunded_cents;
    if (remaining <= 0) throw new HttpError(400, "There is nothing left to refund on this order.");
    const amount = amountCents == null ? remaining : amountCents;
    if (!(amount > 0) || amount > remaining) throw new HttpError(400, "Refund must be more than zero and no more than R" + rand(remaining).toFixed(2) + ".");
    const total = o.refunded_cents + amount;
    const full = total >= o.paid_cents;
    db.prepare("UPDATE orders SET payment_status=?, refunded_cents=?, refunded_at=?, refund_reason=? WHERE id=?")
      .run(full ? "refunded" : "partially_refunded", total, now(), clampStr(reason, 300) || null, id);
    addEvent(id, "refund", o.payment_status, full ? "refunded" : "partially_refunded", "R" + rand(amount).toFixed(2) + (reason ? ": " + clampStr(reason, 300) : ""));
    if (full && o.status !== "refunded") {
      db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(id);
      addEvent(id, "status", o.status, "refunded", "Full refund recorded");
    }
    return orderView(getRow(id));
  });
}

function updateShipping(id, s) {
  const c = cleanShipping(s);
  return tx(() => {
    getRow(id);
    db.prepare("UPDATE orders SET courier=?, tracking_number=?, dispatch_date=? WHERE id=?").run(c.courier || null, c.tracking || null, c.dispatch || null, id);
    addEvent(id, "shipping", null, null, [c.courier, c.tracking, c.dispatch].filter(Boolean).join(" | ") || "Shipping details cleared");
    return orderView(getRow(id));
  });
}

function setNotes(id, notes) {
  return tx(() => {
    getRow(id);
    db.prepare("UPDATE orders SET admin_notes=? WHERE id=?").run(clampStr(notes, 5000), id);
    addEvent(id, "note", null, null, "Admin notes updated");
    return orderView(getRow(id));
  });
}

function setArchived(id, archived) {
  return tx(() => {
    getRow(id);
    db.prepare("UPDATE orders SET archived=? WHERE id=?").run(archived ? 1 : 0, id);
    addEvent(id, "archive", null, null, archived ? "Archived" : "Restored from archive");
    return orderView(getRow(id));
  });
}

module.exports = {
  MAX_ITEMS, MAX_QTY,
  imageInfo, getPricing, buildCostSnapshot, createOrder, financials, orderView, listOrders,
  getOrderDetail, getOrderFile, customerOrders, changeStatus, markPaid, markUnpaid, recordRefund, addEvent,
  promoteCheckout, cleanupCheckouts,
  updateShipping, setNotes, setArchived, getRow
};
