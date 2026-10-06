// Owner email for every order whose online payment is confirmed. Settings live in the admin (stored only on the server):
// notify_email = who receives them (comma-separated for several), smtp_* = the account that sends them
// (Gmail by default: smtp.gmail.com:465 with a Google "app password").
// Sending never blocks or breaks an order: failures are logged on the order's history.
const nodemailer = require("nodemailer");
const { db, getSetting } = require("../db");
const { LAYOUT_LABEL } = require("./constants");
const { esc } = require("./util");
const cfg = require("../config");

function mailConfig() {
  const to = (getSetting("notify_email") || "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  const user = (getSetting("smtp_user") || "").trim();
  const pass = (getSetting("smtp_pass") || "").replace(/\s+/g, ""); // Gmail shows app passwords in groups of four
  if (!to.length || !user || !pass) return null;
  const port = parseInt(getSetting("smtp_port"), 10) || 465;
  return { to, user, pass, host: (getSetting("smtp_host") || "smtp.gmail.com").trim(), port };
}
const isConfigured = () => !!mailConfig();

async function send({ subject, text, html }) {
  const c = mailConfig();
  if (!c) throw new Error("Notification email isn't set up.");
  const transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15000 });
  await transport.sendMail({ from: { name: "VANTA orders", address: c.user }, to: c.to, subject, text, html });
}

const rands = (cents) => "R" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const adminLink = (o) => (cfg.PUBLIC_URL || "http://localhost:" + cfg.PORT) + "/admin/#/orders/" + o.id;

function orderEmail(o, kind) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY item_no").all(o.id);
  const lines = items.map((i) => (items.length > 1 ? "Print " + i.item_no + ": " : "") + (LAYOUT_LABEL[i.layout] || i.layout) + (i.qty > 1 ? " x" + i.qty : "") + ", " + i.orientation + " (" + i.panels * i.qty + " panel" + (i.panels * i.qty === 1 ? "" : "s") + ")");
  const paid = kind === "paid";
  const subject = (paid ? "Paid: " : "New order: ") + o.order_number + " · " + rands(o.total_cents) + (paid ? "" : o.payment_status === "pending" ? " · awaiting payment" : "");
  const rows = [
    ["Order", o.order_number],
    ["Status", paid ? "Paid " + rands(o.paid_cents) + (o.payment_reference ? " (ref " + o.payment_reference + ")" : "") : o.payment_status === "pending" ? "Placed, waiting for payment" : "Placed"],
    ["Customer", o.first_name + " " + o.last_name],
    ["Email", o.email], ["Phone", o.phone],
    ["Deliver to", o.address + ", " + o.city + " " + o.postal_code],
    ["Prints", lines.join("\n")],
    ["Total panels", String(o.panels)],
    ["Order total", rands(o.total_cents)]
  ];
  const intro = paid ? "Payment for this order has been confirmed by iKhokha. It's ready for production." : "A new order has just been placed on vantastudios.co.za.";
  const text = intro + "\n\n" + rows.map((r) => r[0] + ": " + r[1]).join("\n") + "\n\nOpen in admin: " + adminLink(o) + "\n";
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1814;max-width:560px">' +
    '<p style="font-size:16px;margin:0 0 14px"><strong>' + esc(intro) + "</strong></p>" +
    '<table cellpadding="6" style="border-collapse:collapse;width:100%">' +
    rows.map((r) => '<tr><td style="color:#6b6558;vertical-align:top;white-space:nowrap;border-bottom:1px solid #eee">' + esc(r[0]) + '</td><td style="border-bottom:1px solid #eee">' + esc(r[1]).replace(/\n/g, "<br>") + "</td></tr>").join("") +
    '</table><p style="margin:18px 0 0"><a href="' + esc(adminLink(o)) + '" style="background:#c9a24a;color:#12100b;padding:10px 16px;text-decoration:none;font-weight:bold">Open order in admin</a></p></div>';
  return { subject, text, html };
}

// Fire and forget: records the outcome on the order's history, never throws.
function notifyOrder(orderId, kind) {
  if (!isConfigured()) return;
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!o) return;
  const { addEvent } = require("./orders");
  send(orderEmail(o, kind))
    .then(() => addEvent(o.id, "notify", null, null, (kind === "paid" ? "Payment" : "New order") + " email sent"))
    .catch((err) => {
      console.error("Notification email failed for " + o.order_number + ": " + err.message);
      try { addEvent(o.id, "notify", null, null, "Notification email failed: " + String(err.message).slice(0, 150)); } catch (e) { /* ignore */ }
    });
}

async function sendTest() {
  await send({ subject: "VANTA test notification", text: "Notification emails are working. You'll get one every time an order is paid.\n",
    html: '<p style="font-family:Arial,sans-serif">Notification emails are working. You\'ll get one every time an order is paid.</p>' });
}

module.exports = { isConfigured, notifyOrder, sendTest };
