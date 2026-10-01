const fs = require("fs");
const path = require("path");
const { db, tx, now, getSetting, setSetting } = require("../db");
const { UPLOAD_DIR } = require("../config");
const { STATUS_KEYS, STATUS_LABEL, PIPELINE, LAYOUT_PANELS, LAYOUT_LABEL, PAYMENT_LABEL } = require("./constants");
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
function getPricing() {
  return {
    pricePerPanelCents: parseInt(getSetting("price_per_panel_cents"), 10),
    shippingCents: parseInt(getSetting("shipping_cents"), 10)
  };
}

// Freezes the unit costs that apply right now. Later price changes never touch stored orders.
function buildCostSnapshot(panels) {
  const items = db.prepare("SELECT * FROM cost_items WHERE active = 1 ORDER BY sort, id").all();
  const lines = items.map((i) => {
    const quantity = i.basis === "per_panel" ? panels : 1;
    return {
      key: i.key, label: i.label, basis: i.basis, unitCents: i.amount_cents,
      quantity, totalCents: i.amount_cents * quantity, confirmed: !!i.confirmed
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
function createOrder(f, files) {
  const layout = String(f.layout || "");
  const panels = LAYOUT_PANELS[layout];
  if (!panels) throw new HttpError(400, "Unknown layout.");
  if (!["portrait", "landscape"].includes(f.orientation)) throw new HttpError(400, "Unknown orientation.");
  const arrangement = ["side", "stacked"].includes(f.arrangement) ? f.arrangement : null;

  const first = clampStr(f.firstName, 80), last = clampStr(f.lastName, 80);
  const email = clampStr(f.email, 160).toLowerCase();
  if (!first || !last) throw new HttpError(400, "Please enter your first and last name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  const phone = clampStr(f.phone, 40), address = clampStr(f.address, 200), city = clampStr(f.city, 80), postal = clampStr(f.postal, 20);
  if (!phone || !address || !city || !postal) throw new HttpError(400, "Please complete your delivery details.");
  if (!f.rightsConfirmed) throw new HttpError(400, "Please confirm you have the right to print this image.");

  if (!files.original) throw new HttpError(400, "Your original image is missing.");
  if (files.panels.length !== panels) throw new HttpError(400, "The number of print files doesn't match the layout.");

  const { pricePerPanelCents, shippingCents } = getPricing();
  const productCents = pricePerPanelCents * panels;
  const totalCents = productCents + shippingCents;
  const snapshot = buildCostSnapshot(panels);
  const dpi = Number.isFinite(f.dpi) ? Math.max(0, Math.min(2000, Math.round(f.dpi))) : null;
  const placedAt = now();

  return tx(() => {
    const n = parseInt(getSetting("next_order_number"), 10);
    setSetting("next_order_number", n + 1);
    const orderNumber = "VNT-" + n;

    const res = db.prepare(`INSERT INTO orders
      (order_number, created_at, first_name, last_name, email, phone, address, city, postal_code,
       layout, orientation, arrangement, panels, delivery_method,
       price_per_panel_cents, product_cents, shipping_cents, total_cents,
       cost_snapshot, est_cost_cents, dpi_estimate, low_res_confirmed, rights_confirmed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNumber, placedAt, first, last, email, phone, address, city, postal,
        layout, f.orientation, arrangement, panels, "Courier",
        pricePerPanelCents, productCents, shippingCents, totalCents,
        JSON.stringify(snapshot), snapshot.totalCents, dpi, f.lowResConfirmed ? 1 : 0, 1);
    const id = Number(res.lastInsertRowid);

    const dir = path.join(UPLOAD_DIR, orderNumber);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const insertFile = db.prepare(`INSERT INTO order_files
        (order_id, kind, panel_index, panel_label, stored_name, download_name, mime, size, width, height, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

      const o = files.original;
      const originalStored = "original." + o.info.ext;
      fs.writeFileSync(path.join(dir, originalStored), o.buffer);
      insertFile.run(id, "original", null, null, originalStored, orderNumber + "-original-" + safeFilename(o.name, "image." + o.info.ext),
        o.info.mime, o.buffer.length, o.info.width, o.info.height, placedAt);

      files.panels.forEach((p) => {
        const stored = "panel-" + String(p.index).padStart(2, "0") + "." + p.info.ext;
        fs.writeFileSync(path.join(dir, stored), p.buffer);
        const dl = orderNumber + "-panel-" + p.index + "of" + panels + (p.label ? "-" + slug(p.label) : "") + "." + p.info.ext;
        insertFile.run(id, "panel", p.index, p.label || null, stored, dl, p.info.mime, p.buffer.length, p.info.width, p.info.height, placedAt);
      });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    addEvent(id, "placed", null, "new", "Order placed on the website");
    return { id, orderNumber };
  });
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

function orderView(o) {
  const f = financials(o);
  return {
    id: o.id,
    orderNumber: o.order_number,
    createdAt: o.created_at,
    customer: {
      firstName: o.first_name, lastName: o.last_name, name: o.first_name + " " + o.last_name,
      email: o.email, phone: o.phone, address: o.address, city: o.city, postalCode: o.postal_code
    },
    layout: o.layout, layoutLabel: LAYOUT_LABEL[o.layout] || o.layout,
    orientation: o.orientation, arrangement: o.arrangement, panels: o.panels,
    deliveryMethod: o.delivery_method, deliveryStatus: deliveryStatus(o),
    money: {
      pricePerPanel: rand(o.price_per_panel_cents), product: rand(o.product_cents), shipping: rand(o.shipping_cents),
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
function getRow(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o) throw new HttpError(404, "Order not found.");
  return o;
}

function listOrders({ q, status, payment, archived } = {}) {
  const where = [], params = [];
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
    id: f.id, kind: f.kind, panelIndex: f.panel_index, label: f.panel_label,
    downloadName: f.download_name, mime: f.mime, size: f.size, width: f.width, height: f.height,
    url: "/admin/api/orders/" + orderId + "/files/" + f.id
  };
}

function getOrderDetail(id) {
  const o = getRow(id);
  const files = db.prepare("SELECT * FROM order_files WHERE order_id = ? ORDER BY kind DESC, panel_index").all(id).map((f) => fileView(id, f));
  const events = db.prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY id").all(id)
    .map((e) => ({ at: e.at, type: e.type, from: e.from_value, to: e.to_value, detail: e.detail }));
  const others = db.prepare("SELECT id, order_number, created_at, status, total_cents FROM orders WHERE email = ? AND id != ? ORDER BY created_at DESC").all(o.email, id)
    .map((x) => ({ id: x.id, orderNumber: x.order_number, createdAt: x.created_at, status: x.status, statusLabel: STATUS_LABEL[x.status], total: rand(x.total_cents) }));
  const snapshot = JSON.parse(o.cost_snapshot);
  return {
    order: orderView(o), files, events, otherOrders: others,
    costSnapshot: {
      takenAt: snapshot.takenAt, total: rand(snapshot.totalCents),
      lines: snapshot.lines.map((l) => ({ label: l.label, basis: l.basis, unit: rand(l.unitCents), quantity: l.quantity, total: rand(l.totalCents), confirmed: l.confirmed }))
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
  const rows = db.prepare("SELECT * FROM orders WHERE email = ? ORDER BY created_at DESC").all(String(email).toLowerCase());
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
  imageInfo, getPricing, buildCostSnapshot, createOrder, financials, orderView, listOrders,
  getOrderDetail, getOrderFile, customerOrders, changeStatus, markPaid, markUnpaid, recordRefund,
  updateShipping, setNotes, setArchived, getRow
};
