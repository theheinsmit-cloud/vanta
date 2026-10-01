const { db, getSettings } = require("../db");
const { LAYOUT_LABEL, PAYMENT_LABEL } = require("./constants");
const { esc, saDate } = require("./util");

const money = (cents) => "R" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nl = (s) => esc(s).replace(/\n/g, "<br>");

function renderInvoice(o) {
  const s = getSettings();
  const balance = o.total_cents - (o.paid_cents - o.refunded_cents);
  // One line per print: qty = copies, unit price = one copy (price per panel x panels).
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY item_no").all(o.id);
  const itemRows = items.map((i) => {
    const orient = i.orientation === "landscape" ? "landscape" : "portrait";
    const arrangement = i.arrangement === "stacked" ? ", stacked" : "";
    return `<tr>
        <td>VANTA A4 custom metal print${items.length > 1 ? " (print " + i.item_no + ")" : ""}<div class="muted small">${esc(LAYOUT_LABEL[i.layout] || i.layout)} layout, ${i.panels} panel${i.panels > 1 ? "s" : ""} at ${money(i.price_per_panel_cents)} each, ${orient}${arrangement}. Magnetic mounting included.</div></td>
        <td class="r">${i.qty}</td><td class="r">${money(i.price_per_panel_cents * i.panels)}</td><td class="r">${money(i.line_cents)}</td>
      </tr>`;
  }).join("");
  const paidLabel = PAYMENT_LABEL[o.payment_status] || o.payment_status;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${esc(o.order_number)} — ${esc(s.business_name || "VANTA")}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#e9e6df;color:#1a1814;font:14px/1.5 -apple-system,"Segoe UI",Jost,sans-serif}
  .bar{max-width:820px;margin:18px auto 0;display:flex;justify-content:flex-end;gap:10px;padding:0 12px}
  .bar button,.bar a{font:600 12px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;padding:11px 16px;border:1px solid #1a1814;background:#1a1814;color:#f5f1e6;cursor:pointer;text-decoration:none}
  .bar a{background:transparent;color:#1a1814}
  .sheet{max-width:820px;margin:14px auto 40px;background:#fff;padding:48px 52px;box-shadow:0 2px 24px rgba(0,0,0,.12)}
  header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #c9a24a;padding-bottom:22px;margin-bottom:26px}
  h1{margin:0;font:700 30px/1 Georgia,"Bodoni Moda",serif;letter-spacing:.04em}
  .muted{color:#6b6558}
  .small{font-size:12.5px}
  .meta{text-align:right}
  .meta strong{font-size:18px}
  .cols{display:flex;justify-content:space-between;gap:24px;margin-bottom:26px}
  h3{margin:0 0 6px;font:600 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:#8a6d22}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th{font:600 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;text-align:left;padding:10px 8px;border-bottom:1px solid #1a1814}
  td{padding:12px 8px;border-bottom:1px solid #e4e0d6;vertical-align:top}
  th.r,td.r{text-align:right}
  .totals{margin-left:auto;width:290px}
  .totals div{display:flex;justify-content:space-between;padding:6px 8px}
  .totals .grand{border-top:2px solid #1a1814;font-weight:700;font-size:16px;margin-top:4px;padding-top:10px}
  .badge{display:inline-block;font:600 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;padding:6px 10px;border:1px solid #8a6d22;color:#8a6d22}
  footer{margin-top:30px;padding-top:18px;border-top:1px solid #e4e0d6}
  @media print{body{background:#fff}.bar{display:none}.sheet{box-shadow:none;margin:0;padding:0;max-width:none}}
  @media (max-width:600px){.sheet{padding:26px 20px}header,.cols{flex-direction:column}.meta{text-align:left}}
</style></head>
<body>
<div class="bar"><a href="/admin#/orders/${o.id}">Back to order</a><button id="print-btn" type="button">Print / Save as PDF</button></div>
<div class="sheet">
  <header>
    <div>
      <h1>${esc(s.business_name || "VANTA")}</h1>
      ${s.business_legal_name ? `<div class="muted small">${esc(s.business_legal_name)}</div>` : ""}
      ${s.business_address ? `<div class="muted small" style="margin-top:6px">${nl(s.business_address)}</div>` : ""}
      <div class="muted small" style="margin-top:6px">${esc([s.business_email, s.business_phone].filter(Boolean).join("  ·  "))}</div>
      ${s.vat_number ? `<div class="muted small">VAT no. ${esc(s.vat_number)}</div>` : ""}
    </div>
    <div class="meta">
      <div class="muted small">INVOICE / ORDER</div>
      <strong>${esc(o.order_number)}</strong>
      <div class="muted small">Date: ${esc(saDate(o.created_at))}</div>
      <div style="margin-top:10px"><span class="badge">${esc(paidLabel)}</span></div>
    </div>
  </header>

  <div class="cols">
    <div>
      <h3>Billed / delivered to</h3>
      <div><strong>${esc(o.first_name)} ${esc(o.last_name)}</strong></div>
      <div class="small">${esc(o.address)}<br>${esc(o.city)} ${esc(o.postal_code)}</div>
      <div class="small muted">${esc(o.email)}<br>${esc(o.phone)}</div>
    </div>
    <div>
      <h3>Delivery</h3>
      <div class="small">${esc(o.delivery_method)}</div>
      ${o.tracking_number ? `<div class="small muted">${esc(o.courier || "")} ${esc(o.tracking_number)}</div>` : ""}
    </div>
  </div>

  <table>
    <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
    <tbody>
      ${itemRows}
      <tr><td>Delivery (${esc(o.delivery_method)})</td><td class="r">1</td><td class="r">${o.shipping_cents ? money(o.shipping_cents) : "Free"}</td><td class="r">${o.shipping_cents ? money(o.shipping_cents) : "Free"}</td></tr>
    </tbody>
  </table>

  <div class="totals">
    <div class="grand"><span>Total</span><span>${money(o.total_cents)}</span></div>
    <div><span>Paid</span><span>${money(o.paid_cents)}</span></div>
    ${o.refunded_cents ? `<div><span>Refunded</span><span>&minus;${money(o.refunded_cents)}</span></div>` : ""}
    <div><span><strong>Balance due</strong></span><span><strong>${money(Math.max(0, balance))}</strong></span></div>
  </div>

  <footer class="small muted">
    ${s.bank_details && o.payment_status === "pending" ? `<div style="margin-bottom:10px"><h3>Payment details</h3>${nl(s.bank_details)}</div>` : ""}
    ${s.invoice_notes ? `<div>${nl(s.invoice_notes)}</div>` : ""}
  </footer>
</div>
<script src="/admin/static/invoice.js"></script>
</body></html>`;
}

module.exports = { renderInvoice };
