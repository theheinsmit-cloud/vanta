// Online card payments for orders via iKhokha. The flow:
//   order placed -> startPayment() creates a payment link -> customer pays on iKhokha's page ->
//   iKhokha calls our webhook and the customer returns to /payment.html -> confirm() asks iKhokha
//   for the link's real status and only then marks the order paid. A webhook or a page visit is
//   never trusted on its own: the status comes from iKhokha's API, and the amount must match.
const crypto = require("crypto");
const { db, now } = require("../db");
const { HttpError } = require("./util");
const ik = require("./ikhokha");
const orders = require("./orders");

const CALLBACK_PATH = "/api/payments/ikhokha/callback";

const findOrder = (number) => db.prepare("SELECT * FROM orders WHERE order_number = ?").get(String(number || ""));
function orderForToken(number, token) {
  const o = findOrder(number);
  const a = Buffer.from(String((o && o.pay_token) || "")), b = Buffer.from(String(token || ""));
  if (!o || !a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(404, "Order not found.");
  return o;
}
// Private token in the customer's payment links, so only they can see or retry their payment.
function ensureToken(o) {
  if (o.pay_token) return o.pay_token;
  const t = crypto.randomBytes(18).toString("base64url");
  db.prepare("UPDATE orders SET pay_token = ? WHERE id = ?").run(t, o.id);
  return t;
}

// Creates a fresh payment link for an unpaid order (each attempt gets its own reference).
async function startPayment(o, base) {
  if (o.payment_status !== "pending") throw new HttpError(400, "This order is already paid.");
  if (["cancelled", "refunded"].includes(o.status)) throw new HttpError(400, "This order was cancelled.");
  const token = ensureToken(o);
  const attempt = db.prepare("SELECT COUNT(*) AS n FROM order_paylinks WHERE order_id = ?").get(o.id).n + 1;
  const ext = o.order_number + "-" + attempt;
  const back = (r) => base + "/payment.html?order=" + encodeURIComponent(o.order_number) + "&t=" + token + "&r=" + r;
  const link = await ik.createPaylink({
    amountCents: o.total_cents, externalTransactionID: ext, description: "VANTA order " + o.order_number, requesterUrl: base,
    urls: { callbackUrl: base + CALLBACK_PATH, successPageUrl: back("success"), failurePageUrl: back("failed"), cancelUrl: back("cancelled") }
  });
  db.prepare("INSERT INTO order_paylinks (order_id, paylink_id, external_id, amount_cents, created_at) VALUES (?,?,?,?,?)")
    .run(o.id, link.paylinkID, ext, o.total_cents, now());
  orders.addEvent(o.id, "payment", null, null, "Payment link created (attempt " + attempt + ", iKhokha " + link.paylinkID + ")");
  return { paylinkUrl: link.paylinkUrl, token };
}

// Asks iKhokha about every payment link of an unpaid order; marks it paid if one is PAID for the full amount.
async function confirm(o) {
  if (o.payment_status !== "pending") return { paid: o.payment_status !== "pending" };
  const links = db.prepare("SELECT * FROM order_paylinks WHERE order_id = ? ORDER BY id DESC").all(o.id);
  for (const l of links) {
    const s = await ik.getStatus(l.paylink_id);
    if (!s || String(s.status).toUpperCase() !== "PAID") continue;
    if (Number(s.amount) !== o.total_cents) {
      orders.addEvent(o.id, "payment", null, null, "iKhokha reports " + l.paylink_id + " paid with a different amount (" + s.amount + " cents). Not marked as paid; check the iKhokha dashboard.");
      continue;
    }
    try {
      orders.markPaid(o.id, { amountCents: o.total_cents, method: "Card (iKhokha)", reference: l.paylink_id });
    } catch (e) { /* already marked paid by a parallel check */ }
    return { paid: true };
  }
  return { paid: false };
}

// iKhokha's webhook. Always answers 200 so it isn't retried; the signature is checked and logged,
// and payment is only recorded after confirming the status with iKhokha's API.
async function handleWebhook(rawBody, body, signature) {
  const sigOk = ik.verifyWebhook(CALLBACK_PATH, rawBody, body, signature);
  const link = body && body.paylinkID ? db.prepare("SELECT * FROM order_paylinks WHERE paylink_id = ?").get(String(body.paylinkID)) : null;
  if (!link) { console.warn("iKhokha webhook for unknown payment link " + (body && body.paylinkID)); return; }
  if (!link.order_id) return; // admin test payment
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(link.order_id);
  if (!sigOk) console.warn("iKhokha webhook signature did not match for " + link.paylink_id + "; confirming with the API instead");
  orders.addEvent(o.id, "payment", null, null, "iKhokha notification: " + String(body.status || "?") + (sigOk ? "" : " (unverified, checked with iKhokha)"));
  if (String(body.status).toUpperCase() === "SUCCESS" || !sigOk) await confirm(o);
}

// What the customer's payment page may see (needs the order's private token).
const recentChecks = new Map();
async function publicStatus(number, token, check) {
  let o = orderForToken(number, token);
  if (check && o.payment_status === "pending" && ik.isConfigured()) {
    const last = recentChecks.get(o.id) || 0;
    if (Date.now() - last > 2000) {
      recentChecks.set(o.id, Date.now());
      try { await confirm(o); } catch (e) { console.error("Payment check failed for " + o.order_number + ": " + e.message); }
      o = findOrder(number);
    }
  }
  return {
    orderNumber: o.order_number, paid: o.payment_status !== "pending", totalCents: o.total_cents, panels: o.panels,
    canPay: o.payment_status === "pending" && !["cancelled", "refunded"].includes(o.status) && ik.isConfigured()
  };
}

// Admin: a small live test payment that isn't tied to an order (refund it in the iKhokha dashboard).
async function startTestPayment(amountCents, base) {
  if (!(amountCents >= 100 && amountCents <= 5000)) throw new HttpError(400, "Choose a test amount between R1 and R50.");
  const ext = "TEST-" + Date.now();
  const back = base + "/payment.html?test=1";
  const link = await ik.createPaylink({ amountCents, externalTransactionID: ext, description: "VANTA test payment", requesterUrl: base,
    urls: { callbackUrl: base + CALLBACK_PATH, successPageUrl: back + "&r=success", failurePageUrl: back + "&r=failed", cancelUrl: back + "&r=cancelled" } });
  db.prepare("INSERT INTO order_paylinks (order_id, paylink_id, external_id, amount_cents, created_at) VALUES (NULL,?,?,?,?)").run(link.paylinkID, ext, amountCents, now());
  return link;
}

module.exports = { CALLBACK_PATH, ensureToken, orderForToken, startPayment, confirm, handleWebhook, publicStatus, startTestPayment, findOrder };
