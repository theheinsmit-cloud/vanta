(function () {
  "use strict";

  /* ---------- helpers ---------- */
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function money(n) {
    n = Number(n || 0);
    return (n < 0 ? "−" : "") + "R" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  var TZ = "Africa/Johannesburg";
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("en-ZA", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" }) : "—"; }
  function fmtDT(iso) { return iso ? new Date(iso).toLocaleString("en-ZA", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
  function fmtDay(s) { return s ? new Date(s + "T12:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"; }
  function today() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  function qs(o) {
    var p = new URLSearchParams();
    Object.keys(o).forEach(function (k) { if (o[k] !== "" && o[k] != null) p.set(k, o[k]); });
    var s = p.toString();
    return s ? "?" + s : "";
  }
  function pill(cls, label) { return '<span class="pill ' + cls + '">' + esc(label) + "</span>"; }
  function statusPill(o) { return pill("s-" + o.status, o.statusLabel); }
  function payPill(o) { return pill("p-" + o.payment.status, o.payment.statusLabel); }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  // One print in the order, e.g. "Duo × 2 · portrait, stacked".
  function itemLabel(i) {
    return esc(i.layoutLabel) + (i.qty > 1 ? " × " + i.qty : "") + " · " + esc(i.orientation) + (i.layout === "duo" ? ", " + (i.arrangement === "stacked" ? "stacked" : "side by side") : "");
  }
  function configLabel(o) {
    if (o.items.length > 1) return plural(o.items.length, "print") + " · " + plural(o.panels, "panel") + '<div class="muted small">' + o.items.map(function (i) { return esc(i.layoutLabel) + (i.qty > 1 ? " ×" + i.qty : ""); }).join(", ") + "</div>";
    var i = o.items[0] || o;
    var extra = i.layout === "duo" && i.arrangement === "stacked" ? ", stacked" : "";
    return esc(i.layoutLabel) + (i.qty > 1 ? " × " + i.qty : "") + " · " + plural(o.panels, "panel") + '<div class="muted small">' + esc(i.orientation) + extra + "</div>";
  }
  function monthRange(offset) {
    var t = today().split("-").map(Number);
    var d = new Date(Date.UTC(t[0], t[1] - 1 + offset, 1));
    var y = d.getUTCFullYear(), m = d.getUTCMonth();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var mm = String(m + 1).padStart(2, "0");
    return { from: y + "-" + mm + "-01", to: y + "-" + mm + "-" + String(last).padStart(2, "0") };
  }

  /* ---------- api / ui ---------- */
  var csrf = "", meta = null;
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
    if (opts.json !== undefined) { init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.json); }
    if (opts.form) { init.method = "POST"; init.body = opts.form; }
    if (init.method !== "GET") init.headers["x-csrf-token"] = csrf;
    return fetch("/admin/api" + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { location.reload(); throw new Error("Signed out"); }
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }
  var toastTimer;
  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ""; }, isErr ? 5000 : 2600);
  }
  function fail(err) { toast(err.message || "Something went wrong", true); }

  function openModal(o) {
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = '<form class="modal' + (o.wide ? " wide" : "") + '"><h3>' + esc(o.title) + "</h3>" + o.body +
      '<div class="modal-error hidden"></div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button>' +
      '<button class="btn' + (o.danger ? " danger" : "") + '" type="submit">' + esc(o.submit || "Save") + "</button></div></form>";
    var form = $("form", wrap), errBox = $(".modal-error", wrap), prev = document.activeElement;
    function close() { document.removeEventListener("keydown", onKey); wrap.remove(); if (prev && prev.focus) prev.focus(); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("mousedown", function (e) { if (e.target === wrap) close(); });
    $("[data-close]", wrap).addEventListener("click", close);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = $("[type=submit]", form);
      btn.disabled = true; errBox.classList.add("hidden");
      Promise.resolve(o.onSubmit(new FormData(form), form)).then(close, function (err) {
        errBox.textContent = err.message || "Something went wrong";
        errBox.classList.remove("hidden");
        btn.disabled = false;
      });
    });
    $("#modal-root").appendChild(wrap);
    var first = $("input:not([type=hidden]),select,textarea", form) || $("[data-close]", form);
    if (first) first.focus();
    return { close: close };
  }
  // On-brand replacement for window.confirm(). onConfirm may return a promise; a rejection shows inside the dialog.
  function confirmModal(o) {
    return openModal({
      title: o.title, submit: o.submit || "Confirm", danger: o.danger,
      body: '<p class="confirm-msg">' + esc(o.message) + "</p>",
      onSubmit: function () { return o.onConfirm(); }
    });
  }
  function fd(form) { var o = {}; form.forEach(function (v, k) { o[k] = v; }); return o; }

  var view = $("#view"), renderToken = 0;

  /* ---------- shared order table ---------- */
  function ordersTable(list) {
    if (!list.length) return '<div class="tablewrap"><div class="empty">No orders match.</div></div>';
    return '<div class="tablewrap"><table class="tbl"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Configuration</th><th class="r">Amount paid</th><th>Payment</th><th>Status</th><th class="hide-sm">Delivery</th></tr></thead><tbody>' +
      list.map(function (o) {
        return '<tr class="click" data-href="#/orders/' + o.id + '"><td class="nowrap"><a href="#/orders/' + o.id + '"><strong>' + esc(o.orderNumber) + "</strong></a>" + (o.archived ? ' <span class="muted small">(archived)</span>' : "") + "</td>" +
          '<td class="nowrap">' + fmtDate(o.createdAt) + "</td>" +
          "<td>" + esc(o.customer.name) + '<div class="muted small">' + esc(o.customer.email) + "</div></td>" +
          "<td>" + configLabel(o) + "</td>" +
          '<td class="r nowrap">' + money(o.money.paid) + (o.payment.status === "pending" ? '<div class="muted small">of ' + money(o.money.total) + "</div>" : "") + "</td>" +
          "<td>" + payPill(o) + "</td><td>" + statusPill(o) + "</td>" +
          '<td class="hide-sm">' + esc(o.deliveryMethod) + '<div class="muted small">' + esc(o.deliveryStatus) + "</div></td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  /* ---------- dashboard ---------- */
  function pageDashboard(token) {
    return api("/dashboard").then(function (d) {
      if (token !== renderToken) return;
      var c = d.counts;
      function tile(label, key) { return '<a class="stat" href="#/orders?status=' + key + '"><div class="l">' + label + '</div><div class="n">' + (c[key] || 0) + "</div></a>"; }
      function money4(label, all, month, sub, cls) {
        return '<div class="stat ' + (cls || "") + '"><div class="l">' + label + '</div><div class="n">' + money(all) + '</div><div class="s">This month: ' + money(month) + (sub ? "<br>" + sub : "") + "</div></div>";
      }
      var attn = d.attention.length ? d.attention.map(function (g) {
        var link = g.link || (g.key === "unpaid" ? "#/orders?payment=pending" : "#/orders?status=" + g.key);
        return '<div class="attn-group"><h3><a href="' + link + '" style="color:inherit">' + esc(g.title) + "</a><b>" + g.count + "</b></h3>" +
          g.items.map(function (i) {
            return '<a class="attn-item" href="' + (i.id ? "#/orders/" + i.id : link) + '"><span>' + esc(i.label) + "</span><span>" + esc(i.sub) + "</span></a>";
          }).join("") + "</div>";
      }).join("") : '<div class="empty">Nothing needs attention right now.</div>';

      view.innerHTML = '<div class="page-head"><div><div class="eyebrow">Overview</div><h1 class="page">Dashboard</h1></div></div>' +
        '<div class="grid g-5">' + tile("New orders", "new") + tile("In production", "in_production") + tile("Ready to ship", "ready_to_ship") + tile("Shipped", "shipped") + tile("Completed", "completed") + "</div>" +
        '<div class="section"><h2>Money</h2><div class="grid g-4">' +
        money4("Total sales", d.allTime.netSales, d.thisMonth.netSales, "Net of refunds", "gold") +
        money4("Recorded expenses", d.allTime.expenses, d.thisMonth.expenses, "Business " + money(d.expenseSplit.business) + " · Production " + money(d.expenseSplit.production)) +
        money4("Est. contribution", d.allTime.contribution, d.thisMonth.contribution, "Sales minus estimated unit costs") +
        money4("Est. profit", d.allTime.profit, d.thisMonth.profit, "Sales minus all recorded expenses") +
        '</div><p class="hint">Contribution and profit are two different views and shouldn\'t be added together: contribution uses each order\'s estimated unit costs, profit uses the expenses you actually recorded.</p></div>' +
        '<div class="section"><h2>Needs attention</h2><div class="card">' + attn + "</div></div>";
    });
  }

  /* ---------- orders list ---------- */
  function pageOrders(token, query) {
    var statusOpts = '<option value="">All statuses</option>' + meta.statuses.map(function (s) { return '<option value="' + s.key + '"' + (query.status === s.key ? " selected" : "") + ">" + esc(s.label) + "</option>"; }).join("");
    view.innerHTML = '<div class="page-head"><div><div class="eyebrow">Orders</div><h1 class="page">All orders</h1></div></div>' +
      '<div class="toolbar"><div class="grow"><label class="lbl" for="f-q">Search</label><input id="f-q" type="search" placeholder="Order number, customer, email or phone" value="' + esc(query.q || "") + '"></div>' +
      '<div><label class="lbl" for="f-status">Status</label><select id="f-status">' + statusOpts + "</select></div>" +
      '<div><label class="lbl" for="f-pay">Payment</label><select id="f-pay"><option value="">Any</option><option value="pending"' + (query.payment === "pending" ? " selected" : "") + '>Pending</option><option value="paid"' + (query.payment === "paid" ? " selected" : "") + '>Paid</option><option value="partially_refunded">Partially refunded</option><option value="refunded">Refunded</option></select></div>' +
      '<div><label class="lbl" for="f-arch">Archived</label><select id="f-arch"><option value="">Hide archived</option><option value="all"' + (query.archived === "all" ? " selected" : "") + '>Include archived</option><option value="1"' + (query.archived === "1" ? " selected" : "") + ">Only archived</option></select></div></div>" +
      '<div id="orders-box"></div>';
    var timer, seq = 0;
    function load() {
      var f = { q: $("#f-q").value.trim(), status: $("#f-status").value, payment: $("#f-pay").value, archived: $("#f-arch").value };
      var mine = ++seq;
      history.replaceState(null, "", "#/orders" + qs(f));
      return api("/orders" + qs(f)).then(function (r) { if (mine === seq && token === renderToken) $("#orders-box").innerHTML = ordersTable(r.orders); }).catch(fail);
    }
    $("#f-q").addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    ["#f-status", "#f-pay", "#f-arch"].forEach(function (s) { $(s).addEventListener("change", load); });
    return load();
  }

  /* ---------- order detail ---------- */
  var PIPE = ["new", "artwork_check", "ready_for_production", "in_production", "ready_to_ship", "shipped", "completed"];

  function pageOrder(token, id, keepScroll) {
    var y = window.scrollY;
    return api("/orders/" + id).then(function (d) {
      if (token !== renderToken) return;
      renderOrder(d, id);
      if (keepScroll) window.scrollTo(0, y);
    });
  }

  function renderOrder(d, id) {
    var o = d.order, m = o.money, c = o.customer;
    var custHref = "#/customer/" + encodeURIComponent(c.email);
    var idx = PIPE.indexOf(o.status), next = idx >= 0 && idx < PIPE.length - 1 ? PIPE[idx + 1] : null;
    var label = function (k) { return (meta.statuses.filter(function (s) { return s.key === k; })[0] || {}).label || k; };
    var inactive = o.status === "cancelled" || o.status === "refunded";

    var steps = PIPE.map(function (k, i) {
      var cls = "step" + (k === o.status ? " current" : (idx >= 0 && i < idx ? " done" : ""));
      return '<button type="button" class="' + cls + '" data-status="' + k + '">' + esc(label(k)) + "</button>";
    }).join("");

    // Artwork grouped per print: its original upload, then its panels in mounting order.
    var multi = o.items.length > 1;
    var filesHtml = o.items.map(function (it) {
      var mine = d.files.filter(function (f) { return f.itemId === it.id; });
      var original = mine.filter(function (f) { return f.kind === "original"; })[0];
      var panels = mine.filter(function (f) { return f.kind === "panel"; });
      var head = '<div class="print-head"><strong>' + (multi ? "Print " + it.no + " · " : "") + itemLabel(it) + "</strong>" +
        '<span class="muted small">' + plural(it.panels, "panel") + (it.qty > 1 ? " per copy · <strong>make " + it.qty + " copies</strong>" : "") + (it.dpiEstimate ? " · about " + it.dpiEstimate + " DPI" : "") + "</span>" +
        (it.lowResConfirmed ? '<span class="pill s-cancelled">Low resolution accepted</span>' : "") + "</div>";
      return head + '<div class="files">' + (original ? '<div class="file orig"><a href="' + original.url + '" target="_blank" rel="noopener"><img class="thumb" src="' + original.url + '" alt="Original upload" loading="lazy"></a><div class="body"><div class="t">Customer\'s original upload</div>' +
        '<div class="m">' + esc(original.downloadName) + "<br>" + (original.width ? original.width + " × " + original.height + " px · " : "") + fmtSize(original.size) + '</div><div><a class="btn sm ghost" href="' + original.url + '?download=1">Download original</a></div></div></div>' : "") +
        panels.map(function (f) {
          return '<div class="file"><a href="' + f.url + '" target="_blank" rel="noopener"><img class="thumb" src="' + f.url + '" alt="Panel ' + f.panelIndex + '" loading="lazy"></a>' +
            '<div class="t">Panel ' + f.panelIndex + " of " + it.panels + (f.label ? " · " + esc(f.label) : "") + '</div><div class="m">' + (f.width ? f.width + " × " + f.height + " px · " : "") + fmtSize(f.size) + '</div><a class="btn sm ghost" href="' + f.url + '?download=1">Download</a></div>';
        }).join("") + "</div>";
    }).join("");
    var lowResItems = o.items.filter(function (i) { return i.lowResConfirmed; });

    var paidDetail = o.payment.paidAt ? '<div class="money-row"><span class="muted">Paid on</span><span>' + fmtDate(o.payment.paidAt) + (o.payment.method ? " · " + esc(o.payment.method) : "") + "</span></div>" +
      (o.payment.reference ? '<div class="money-row"><span class="muted">Reference</span><span>' + esc(o.payment.reference) + "</span></div>" : "") : "";
    var canRefund = m.paid - m.refunded > 0;
    var costLines = d.costSnapshot.lines.map(function (l) {
      return "<tr><td>" + esc(l.label) + '</td><td class="muted small">' + (l.basis === "per_panel" ? "per panel" : "per order") + '</td><td class="r nowrap">' +
        money(l.unit) + (l.quantity !== 1 ? " × " + l.quantity : "") + '</td><td class="r nowrap">' + money(l.total) + "</td></tr>";
    }).join("");

    var events = d.events.slice().reverse().map(function (e) {
      var text = e.type === "status" ? "Status: " + esc(label(e.from)) + " → <strong>" + esc(label(e.to)) + "</strong>" + (e.detail ? " · " + esc(e.detail) : "")
        : e.type === "placed" ? "Order placed on the website"
        : e.type === "payment" ? "Payment " + esc(e.from) + " → <strong>" + esc(e.to) + "</strong>" + (e.detail ? " · " + esc(e.detail) : "")
        : e.type === "refund" ? "Refund recorded · " + esc(e.detail || "")
        : e.type === "shipping" ? "Shipping details saved · " + esc(e.detail || "")
        : esc(e.detail || e.type);
      return '<li><div class="when">' + fmtDT(e.at) + '</div><div class="what">' + text + "</div></li>";
    }).join("");

    var keyDates = [["Placed", o.timestamps.placed], ["Production started", o.timestamps.productionStarted], ["Ready to ship", o.timestamps.readyToShip], ["Shipped", o.timestamps.shipped], ["Completed", o.timestamps.completed]]
      .filter(function (k) { return k[1]; }).map(function (k) { return "<dt>" + k[0] + "</dt><dd>" + fmtDT(k[1]) + "</dd>"; }).join("");

    view.innerHTML =
      '<a class="back" href="#/orders">&larr; All orders</a>' +
      '<div class="page-head"><div><div class="eyebrow">Order</div><h1 class="page">' + esc(o.orderNumber) + '</h1><div class="actions" style="margin-top:12px">' + statusPill(o) + payPill(o) + (o.archived ? pill("s-cancelled", "Archived") : "") + "</div></div>" +
      '<div class="actions"><a class="btn ghost" href="/admin/orders/' + o.id + '/invoice" target="_blank" rel="noopener">Invoice</a>' +
      (d.files.length ? '<a class="btn ghost" href="/admin/api/orders/' + o.id + '/download-all">Download all files</a>' : "") +
      '<button class="btn ghost" type="button" id="btn-archive">' + (o.archived ? "Restore" : "Archive") + "</button></div></div>" +

      '<div class="grid g-detail"><div class="stack">' +

      // production
      '<section class="card"><h2>Production status</h2><div class="steps">' + steps + "</div>" +
      '<div class="actions">' + (next ? '<button class="btn" type="button" id="btn-advance">Move to ' + esc(label(next)) + "</button>" : "") +
      (!inactive ? '<button class="btn danger" type="button" id="btn-cancel">Cancel order</button>' : '<button class="btn ghost" type="button" data-status="new">Reopen as New</button>') + "</div>" +
      (inactive ? '<p class="hint">This order is ' + esc(o.statusLabel.toLowerCase()) + ". It stays on record so your totals remain explainable.</p>" : "") +
      (lowResItems.length ? '<div class="notice warn" style="margin-top:14px">The customer accepted a lower-resolution print' + (multi ? " for " + lowResItems.map(function (i) { return "print " + i.no + " (about " + (i.dpiEstimate || "?") + " DPI)"; }).join(", ") : " (about " + (lowResItems[0].dpiEstimate || "?") + " DPI)") + ". Check the artwork before production.</div>" : "") + "</section>" +

      // artwork
      '<section class="card"><div class="card-head"><h2>Artwork</h2>' + (d.files.length ? '<a class="btn sm ghost" href="/admin/api/orders/' + o.id + '/download-all">Download all (.zip)</a>' : "") + "</div>" +
      '<p class="hint" style="margin:-6px 0 14px">' + (multi ? "This order has " + plural(o.items.length, "separate print") + ". " : "") + 'Panels are numbered in mounting order: left to right, top to bottom. Print files are cropped from the customer\'s original upload, which is kept untouched.</p>' +
      (d.files.length ? '<div class="prints">' + filesHtml + "</div>" : '<div class="empty">No files stored for this order.</div>') +
      '<p class="hint">Rights confirmed by customer: ' + (o.artwork.rightsConfirmed ? "yes" : "no") + "</p></section>" +

      // financials
      '<section class="card"><div class="card-head"><h2>Financials</h2><div class="actions">' +
      (o.payment.status === "pending" && d.paylinks.length ? '<button class="btn sm" type="button" id="btn-paycheck">Check payment status</button>' : "") +
      (o.payment.status === "pending" ? '<button class="btn sm' + (d.paylinks.length ? " ghost" : "") + '" type="button" id="btn-pay">Record payment</button>' : "") +
      (o.payment.status === "paid" && m.refunded === 0 ? '<button class="btn sm ghost" type="button" id="btn-unpay">Mark as unpaid</button>' : "") +
      (canRefund ? '<button class="btn sm danger" type="button" id="btn-refund">Record refund</button>' : "") + "</div></div>" +
      (d.paylinks.length ? '<p class="hint" style="margin:-4px 0 12px">Online payment (iKhokha): ' + d.paylinks.map(function (l) { return esc(l.reference) + " · " + esc(l.paylinkId); }).join(", ") +
        (o.payment.status === "pending" ? ". Not paid yet. Paid orders are marked automatically; use <strong>Check payment status</strong> if one seems stuck." : ".") + "</p>" : "") +
      // As frozen when the order was placed; later pricing changes never alter these.
      '<div class="money-row"><span>Total panels</span><span>' + o.panels + "</span></div>" +
      '<div class="money-row"><span>Product subtotal (' + o.panels + " × " + money(m.pricePerPanel) + ")</span><span>" + money(m.product) + "</span></div>" +
      (m.promoSaving ? '<div class="money-row"><span class="muted">' + esc(m.promoName || 'Special') + ' price</span><span class="muted">' + money(m.pricePerPanel) + ' per panel instead of ' + money(m.regularPricePerPanel) + ' (saved ' + money(m.promoSaving) + ')</span></div>' : '') +
      (m.discount ? '<div class="money-row"><span>Volume discount (' + m.discountPct + "%)</span><span class=\"pos\">−" + money(m.discount) + "</span></div>"
        : '<div class="money-row"><span class="muted">Volume discount</span><span class="muted">None</span></div>') +
      '<div class="money-row"><span>Discounted product subtotal</span><span>' + money(m.discountedProduct) + "</span></div>" +
      '<div class="money-row"><span>Delivery &amp; handling <span class="muted small">(customer sees free delivery)</span></span><span>' + money(m.shipping) + "</span></div>" +
      '<p class="hint" style="margin:4px 0 8px">Customer saw: ' + o.panels + ' × ' + money(m.regularPricePerPanel + m.shipping) + (m.promoSaving ? ' − ' + money(m.promoSaving) + ' ' + esc(m.promoName || 'special') : '') + (o.panels > 1 ? ' − ' + money((o.panels - 1) * m.shipping) + ' multi-panel discount' : '') + (m.discount ? ' − ' + money(m.discount) + ' volume discount (' + m.discountPct + '%)' : '') + ', free delivery.</p>' +
      '<div class="money-row total"><span>Order total</span><span>' + money(m.total) + "</span></div>" +
      '<div class="money-row"><span class="muted">Payment status</span><span>' + payPill(o) + "</span></div>" +
      '<div class="money-row"><span class="muted">Amount paid</span><span>' + money(m.paid) + "</span></div>" + paidDetail +
      (m.refunded ? '<div class="money-row"><span class="muted">Refunded' + (o.payment.refundedAt ? " on " + fmtDate(o.payment.refundedAt) : "") + '</span><span class="neg">−' + money(m.refunded) + "</span></div>" + (o.payment.refundReason ? '<div class="money-row"><span class="muted">Refund reason</span><span>' + esc(o.payment.refundReason) + "</span></div>" : "") : "") +
      '<div class="money-row"><span class="muted">Estimated production cost</span><span>' + (m.costCounted ? money(m.estCost) : money(0) + ' <span class="muted small">(never produced)</span>') + "</span></div>" +
      '<div class="money-row total"><span>Estimated contribution</span><span class="' + (m.contribution == null ? "muted" : m.contribution < 0 ? "neg" : "pos") + '">' + (m.contribution == null ? "— (not paid)" : money(m.contribution)) + "</span></div>" +
      '<details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">Cost breakdown as at ' + fmtDate(d.costSnapshot.takenAt) + '</summary><div class="tablewrap" style="margin-top:10px"><table class="tbl" style="min-width:0"><tbody>' + costLines +
      '</tbody><tfoot><tr><td colspan="3">Estimated cost for this order</td><td class="r nowrap">' + money(d.costSnapshot.total) + '</td></tr></tfoot></table></div><p class="hint">These are the unit costs that applied when the order was placed. Later cost changes never alter this order.</p></details></section>' +

      // history
      '<section class="card"><h2>History</h2><ul class="timeline">' + events + "</ul></section>" +

      '</div><div class="stack">' +

      // customer
      '<section class="card"><h2>Customer</h2><dl class="kv"><dt>Name</dt><dd><a href="' + custHref + '">' + esc(c.name) + "</a></dd>" +
      '<dt>Email</dt><dd><a href="' + custHref + '">' + esc(c.email) + '</a> <a class="muted small" href="mailto:' + esc(c.email) + '">(write)</a></dd>' +
      '<dt>Phone</dt><dd><a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + "</a></dd>" +
      "<dt>Address</dt><dd>" + esc(c.address) + "<br>" + esc(c.city) + " " + esc(c.postalCode) + "</dd></dl></section>" +

      // order info
      '<section class="card"><h2>Order</h2><dl class="kv"><dt>' + (multi ? "Prints" : "Configuration") + "</dt><dd>" +
      o.items.map(function (i) { return (multi ? i.no + ". " : "") + itemLabel(i); }).join("<br>") + "</dd>" +
      "<dt>Total panels</dt><dd>" + o.panels + "</dd>" +
      "<dt>Delivery</dt><dd>" + esc(o.deliveryMethod) + " · " + esc(o.deliveryStatus) + "</dd>" + keyDates +
      "<dt>Stock</dt><dd>" + (o.stockDeducted ? "Deducted" : "Not yet deducted") + "</dd></dl></section>" +

      // shipping
      '<section class="card"><h2>Shipping</h2><form id="ship-form"><div class="field"><label class="lbl" for="sh-courier">Courier</label><input id="sh-courier" name="courier" value="' + esc(o.shipping.courier || "") + '" maxlength="80"></div>' +
      '<div class="field"><label class="lbl" for="sh-track">Tracking number</label><input id="sh-track" name="trackingNumber" value="' + esc(o.shipping.trackingNumber || "") + '" maxlength="80"></div>' +
      '<div class="field"><label class="lbl" for="sh-date">Dispatch date</label><input id="sh-date" name="dispatchDate" type="date" value="' + esc(o.shipping.dispatchDate || "") + '"></div>' +
      '<button class="btn sm" type="submit">Save shipping details</button></form></section>' +

      // notes
      '<section class="card"><h2>Admin notes</h2><form id="notes-form"><div class="field"><textarea name="notes" maxlength="5000" placeholder="e.g. reprint panel 2, waiting for aluminium">' + esc(o.adminNotes) + '</textarea><p class="hint">Internal only. Never shown to the customer.</p></div><button class="btn sm" type="submit">Save notes</button></form></section>' +

      (d.otherOrders.length ? '<section class="card"><h2>Other orders by this customer</h2>' + d.otherOrders.map(function (x) {
        return '<a class="attn-item" href="#/orders/' + x.id + '"><span>' + esc(x.orderNumber) + " · " + fmtDate(x.createdAt) + "</span><span>" + esc(x.statusLabel) + " · " + money(x.total) + "</span></a>";
      }).join("") + "</section>" : "") +
      "</div></div>";

    bindOrder(d, id);
  }

  function bindOrder(d, id) {
    var o = d.order, token = renderToken;
    function reload() { return pageOrder(token, id, true); }
    function run(p, msg) { return p.then(function () { if (msg) toast(msg); return reload(); }).catch(fail); }

    function setStatus(to) {
      if (to === o.status) return;
      if (to === "shipped") return shippedModal();
      if (to === "cancelled") return cancelModal();
      api("/orders/" + id + "/status", { json: { status: to } }).then(function () { toast("Status updated"); return reload(); }).catch(fail);
    }
    function shippedModal() {
      openModal({
        title: "Mark as shipped",
        body: '<p class="muted small" style="margin-bottom:14px">Courier details are kept against the order. You can edit them later.</p>' +
          '<div class="field"><label class="lbl">Courier</label><input name="courier" value="' + esc(o.shipping.courier || "") + '" maxlength="80"></div>' +
          '<div class="field"><label class="lbl">Tracking number</label><input name="trackingNumber" value="' + esc(o.shipping.trackingNumber || "") + '" maxlength="80"></div>' +
          '<div class="field"><label class="lbl">Dispatch date</label><input name="dispatchDate" type="date" required value="' + esc(o.shipping.dispatchDate || today()) + '"></div>',
        submit: "Mark as shipped",
        onSubmit: function (f) {
          var v = fd(f);
          return api("/orders/" + id + "/status", { json: { status: "shipped", shipping: v } }).then(function () { toast("Marked as shipped"); reload(); });
        }
      });
    }
    function cancelModal() {
      openModal({
        title: "Cancel this order?",
        body: (o.money.paid > 0 && o.money.refunded < o.money.paid ? '<div class="notice warn" style="margin-bottom:14px">This order has been paid. Cancelling doesn\'t refund it: record a refund afterwards if the money goes back.</div>' : "") +
          '<p class="muted small" style="margin-bottom:12px">The order stays on record and can be reopened.</p><div class="field"><label class="lbl">Reason (optional)</label><input name="note" maxlength="300"></div>',
        submit: "Cancel order",
        onSubmit: function (f) { return api("/orders/" + id + "/status", { json: { status: "cancelled", note: f.get("note") } }).then(function () { toast("Order cancelled"); reload(); }); }
      });
    }

    $$("[data-status]", view).forEach(function (b) { b.addEventListener("click", function () { setStatus(b.getAttribute("data-status")); }); });
    var adv = $("#btn-advance");
    if (adv) adv.addEventListener("click", function () { setStatus(PIPE[PIPE.indexOf(o.status) + 1]); });
    var cancel = $("#btn-cancel");
    if (cancel) cancel.addEventListener("click", cancelModal);

    $("#btn-archive").addEventListener("click", function () {
      confirmModal({
        title: o.archived ? "Restore order" : "Archive order",
        message: o.archived ? "Restore this order to the main list?" : "Archive this order? It stays in your totals but is hidden from the default list.",
        submit: o.archived ? "Restore" : "Archive",
        onConfirm: function () { return run(api("/orders/" + id + "/archive", { json: { archived: !o.archived } }), o.archived ? "Order restored" : "Order archived"); }
      });
    });

    var payCheck = $("#btn-paycheck");
    if (payCheck) payCheck.addEventListener("click", function () {
      payCheck.disabled = true;
      api("/orders/" + id + "/payment-check", { json: {} }).then(function (r) {
        toast(r.paid ? "Payment confirmed by iKhokha" : "iKhokha shows no completed payment yet");
        return reload();
      }).catch(fail).then(function () { payCheck.disabled = false; });
    });

    var pay = $("#btn-pay");
    if (pay) pay.addEventListener("click", function () {
      openModal({
        title: "Record payment",
        body: '<div class="field"><label class="lbl">Amount received (R)</label><input name="amount" type="number" step="0.01" min="0.01" required value="' + o.money.total.toFixed(2) + '"></div>' +
          '<div class="row"><div class="field"><label class="lbl">Method</label><select name="method"><option>EFT</option><option>Card</option><option>Cash</option><option>Other</option></select></div>' +
          '<div class="field"><label class="lbl">Date received</label><input name="date" type="date" required value="' + today() + '"></div></div>' +
          '<div class="field"><label class="lbl">Reference (optional)</label><input name="reference" maxlength="120"></div>',
        submit: "Record payment",
        onSubmit: function (f) { var v = fd(f); v.action = "paid"; return api("/orders/" + id + "/payment", { json: v }).then(function () { toast("Payment recorded"); reload(); }); }
      });
    });
    var unpay = $("#btn-unpay");
    if (unpay) unpay.addEventListener("click", function () {
      confirmModal({
        title: "Mark as not paid", danger: true, submit: "Mark not paid",
        message: "Mark this order as not paid? Use this only to correct a mistake.",
        onConfirm: function () { return run(api("/orders/" + id + "/payment", { json: { action: "unpaid" } }), "Payment reverted"); }
      });
    });
    var ref = $("#btn-refund");
    if (ref) ref.addEventListener("click", function () {
      var left = o.money.paid - o.money.refunded;
      openModal({
        title: "Record refund",
        body: '<p class="muted small" style="margin-bottom:14px">Refunding the full amount also sets the order to Refunded. Up to ' + money(left) + " can be refunded.</p>" +
          '<div class="field"><label class="lbl">Refund amount (R)</label><input name="amount" type="number" step="0.01" min="0.01" max="' + left.toFixed(2) + '" required value="' + left.toFixed(2) + '"></div>' +
          '<div class="field"><label class="lbl">Reason</label><input name="reason" maxlength="300"></div>',
        submit: "Record refund",
        onSubmit: function (f) { return api("/orders/" + id + "/refund", { json: fd(f) }).then(function () { toast("Refund recorded"); reload(); }); }
      });
    });

    $("#ship-form").addEventListener("submit", function (e) {
      e.preventDefault();
      run(api("/orders/" + id + "/shipping", { json: fd(new FormData(e.target)) }), "Shipping details saved");
    });
    $("#notes-form").addEventListener("submit", function (e) {
      e.preventDefault();
      run(api("/orders/" + id + "/notes", { json: fd(new FormData(e.target)) }), "Notes saved");
    });
  }

  /* ---------- customer ---------- */
  function pageCustomer(token, email) {
    return api("/customer" + qs({ email: email })).then(function (d) {
      if (token !== renderToken) return;
      var c = d.customer;
      var spent = d.orders.reduce(function (s, o) { return s + o.money.net; }, 0);
      view.innerHTML = '<a class="back" href="#/orders">&larr; All orders</a><div class="page-head"><div><div class="eyebrow">Customer</div><h1 class="page">' + esc(c.name) + "</h1></div></div>" +
        '<div class="grid g-3"><div class="stat"><div class="l">Orders</div><div class="n">' + d.orders.length + '</div></div><div class="stat"><div class="l">Net spend</div><div class="n">' + money(spent) + "</div></div>" +
        '<div class="stat"><div class="l">Contact</div><div class="s" style="margin-top:8px;color:var(--text)"><a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a><br>" + esc(c.phone) + "<br>" + esc(c.city) + "</div></div></div>" +
        '<div class="section"><h2>Order history</h2>' + ordersTable(d.orders) + "</div>";
    });
  }

  /* ---------- finance ---------- */
  var period = { preset: "month", from: "", to: "" };
  function periodRange() {
    if (period.preset === "month") return monthRange(0);
    if (period.preset === "last") return monthRange(-1);
    if (period.preset === "custom") return { from: period.from, to: period.to };
    return { from: "", to: "" };
  }
  function periodBar() {
    var p = period.preset;
    return '<div><label class="lbl" for="pr-preset">Period</label><select id="pr-preset"><option value="month"' + (p === "month" ? " selected" : "") + '>This month</option><option value="last"' + (p === "last" ? " selected" : "") + '>Last month</option><option value="all"' + (p === "all" ? " selected" : "") + '>All time</option><option value="custom"' + (p === "custom" ? " selected" : "") + ">Custom</option></select></div>" +
      '<div class="' + (p === "custom" ? "" : "hidden") + '" id="pr-from-w"><label class="lbl" for="pr-from">From</label><input id="pr-from" type="date" value="' + esc(period.from) + '"></div>' +
      '<div class="' + (p === "custom" ? "" : "hidden") + '" id="pr-to-w"><label class="lbl" for="pr-to">To</label><input id="pr-to" type="date" value="' + esc(period.to) + '"></div>';
  }
  function bindPeriod(reload) {
    $("#pr-preset").addEventListener("change", function () {
      period.preset = this.value;
      $("#pr-from-w").classList.toggle("hidden", this.value !== "custom");
      $("#pr-to-w").classList.toggle("hidden", this.value !== "custom");
      reload();
    });
    ["#pr-from", "#pr-to"].forEach(function (s) {
      $(s).addEventListener("change", function () { period.from = $("#pr-from").value; period.to = $("#pr-to").value; reload(); });
    });
  }

  function pageFinance(token, tab) {
    tab = tab || "income";
    var tabs = [["income", "Income"], ["expenses", "Expenses"], ["costs", "Unit costs"]];
    view.innerHTML = '<div class="page-head"><div><div class="eyebrow">Finance</div><h1 class="page">Finance</h1></div></div><div class="tabs">' +
      tabs.map(function (t) { return '<a href="#/finance/' + t[0] + '" class="' + (t[0] === tab ? "active" : "") + '">' + t[1] + "</a>"; }).join("") + '</div><div id="fin-body"></div>';
    var body = $("#fin-body");
    if (tab === "expenses") return financeExpenses(token, body);
    if (tab === "costs") return financeCosts(token, body);
    return financeIncome(token, body);
  }

  function financeIncome(token, body) {
    body.innerHTML = '<div class="toolbar">' + periodBar() + '</div><div id="inc-box"></div>';
    function load() {
      var r = periodRange();
      return api("/finance/income" + qs(r)).then(function (d) {
        if (token !== renderToken) return;
        $("#inc-box").innerHTML = '<div class="grid g-4"><div class="stat"><div class="l">Gross sales</div><div class="n">' + money(d.grossSales) + '</div><div class="s">Prints, from paid orders</div></div>' +
          '<div class="stat"><div class="l">Shipping income</div><div class="n">' + money(d.shippingIncome) + '</div></div>' +
          '<div class="stat"><div class="l">Refunds</div><div class="n neg">' + (d.refunds ? "−" + money(d.refunds) : money(0)) + '</div></div>' +
          '<div class="stat gold"><div class="l">Net recorded sales</div><div class="n">' + money(d.netSales) + '</div><div class="s">Est. contribution ' + money(d.estimatedContribution) + "</div></div></div>" +
          '<p class="hint">Generated automatically from paid orders. Record a payment on the order page and it appears here.</p>' +
          '<div class="section"><h2>Paid orders in this period (' + d.orderCount + ")</h2>" + (d.rows.length ? '<div class="tablewrap"><table class="tbl"><thead><tr><th>Order</th><th>Paid</th><th>Customer</th><th class="r">Prints</th><th class="r">Shipping</th><th class="r">Refunded</th><th class="r">Net</th></tr></thead><tbody>' +
            d.rows.map(function (r) { return '<tr class="click" data-href="#/orders/' + r.id + '"><td><a href="#/orders/' + r.id + '">' + esc(r.orderNumber) + "</a></td><td class=\"nowrap\">" + fmtDate(r.paidAt) + "</td><td>" + esc(r.customer) + '</td><td class="r">' + money(r.product) + '</td><td class="r">' + money(r.shipping) + '</td><td class="r">' + (r.refunded ? "−" + money(r.refunded) : "—") + '</td><td class="r">' + money(r.net) + "</td></tr>"; }).join("") +
            "</tbody></table></div>" : '<div class="tablewrap"><div class="empty">No paid orders in this period.</div></div>') + "</div>";
      }).catch(fail);
    }
    bindPeriod(load);
    return load();
  }

  var TYPE_LABEL = { business: "Business / startup", production: "Production / per-unit" };
  function financeExpenses(token, body) {
    var filters = { category: "", type: "", voided: "" };
    body.innerHTML = '<div class="toolbar">' + periodBar() +
      '<div><label class="lbl" for="ex-cat">Category</label><select id="ex-cat"><option value="">All</option>' + meta.expenseCategories.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("") + "</select></div>" +
      '<div><label class="lbl" for="ex-type">Type</label><select id="ex-type"><option value="">All</option><option value="business">Business / startup</option><option value="production">Production / per-unit</option></select></div>' +
      '<div><label class="check" style="height:42px"><input type="checkbox" id="ex-void"> Show voided</label></div>' +
      '<div style="margin-left:auto"><button class="btn" type="button" id="ex-add">Add expense</button></div></div><div id="exp-box"></div>';
    var list = [];
    function load() {
      filters.category = $("#ex-cat").value; filters.type = $("#ex-type").value; filters.voided = $("#ex-void").checked ? "1" : "";
      var r = periodRange();
      return api("/finance/expenses" + qs({ from: r.from, to: r.to, category: filters.category, type: filters.type, voided: filters.voided })).then(function (d) {
        if (token !== renderToken) return;
        list = d.expenses;
        var t = d.totals;
        var cats = Object.keys(t.byCategory).sort().map(function (k) { return "<dt>" + esc(k) + "</dt><dd>" + money(t.byCategory[k]) + "</dd>"; }).join("");
        $("#exp-box").innerHTML = '<div class="grid g-3"><div class="stat gold"><div class="l">Total spent</div><div class="n">' + money(t.total) + '</div></div>' +
          '<div class="stat"><div class="l">Business / startup</div><div class="n">' + money(t.business) + '</div><div class="s">Equipment, software, overheads</div></div>' +
          '<div class="stat"><div class="l">Production / per-unit</div><div class="n">' + money(t.production) + '</div><div class="s">Stock, printing, packaging</div></div></div>' +
          '<div class="notice" style="margin:16px 0">Both types count towards total spend. Only the <a href="#/finance/costs">Unit costs</a> settings decide what a single print costs, so buying a heat press never inflates one customer\'s print cost.</div>' +
          (d.expenses.length ? '<div class="tablewrap"><table class="tbl"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Type</th><th class="r">Amount</th><th></th></tr></thead><tbody>' +
            d.expenses.map(function (e, i) {
              return '<tr class="' + (e.voided ? "voided" : "") + '"><td class="nowrap">' + fmtDay(e.date) + "</td><td>" + esc(e.description) + (e.supplier ? '<div class="muted small">' + esc(e.supplier) + "</div>" : "") + (e.notes ? '<div class="muted small">' + esc(e.notes) + "</div>" : "") + (e.voided ? '<div class="small" style="text-decoration:none">Voided' + (e.voidReason ? ": " + esc(e.voidReason) : "") + "</div>" : "") + "</td><td>" + esc(e.category) + "</td><td>" + pill("t-" + e.costType, TYPE_LABEL[e.costType]) + '</td><td class="r nowrap">' + money(e.amount) + "</td>" +
                '<td class="nowrap right">' + (e.receipt ? '<a class="small" href="' + e.receipt.url + '">Receipt</a> ' : "") +
                '<button class="btn sm ghost" type="button" data-edit="' + i + '">Edit</button> <button class="btn sm ' + (e.voided ? "ghost" : "danger") + '" type="button" data-void="' + i + '">' + (e.voided ? "Restore" : "Void") + "</button></td></tr>";
            }).join("") + "</tbody></table></div>" + (cats ? '<div class="section"><h2>By category</h2><div class="card"><dl class="kv">' + cats + "</dl></div></div>" : "") : '<div class="tablewrap"><div class="empty">No expenses recorded for this period.</div></div>');
        $$("[data-edit]", body).forEach(function (b) { b.addEventListener("click", function () { expenseModal(list[+b.getAttribute("data-edit")]); }); });
        $$("[data-void]", body).forEach(function (b) { b.addEventListener("click", function () { voidExpense(list[+b.getAttribute("data-void")]); }); });
      }).catch(fail);
    }
    function expenseModal(e) {
      var isEdit = !!e; e = e || { date: today(), description: "", category: "Other", costType: "business", amount: "", supplier: "", notes: "" };
      openModal({
        title: isEdit ? "Edit expense" : "Add expense", wide: true, submit: isEdit ? "Save changes" : "Add expense",
        body: '<div class="row"><div class="field"><label class="lbl">Date</label><input name="date" type="date" required value="' + esc(e.date) + '"></div>' +
          '<div class="field"><label class="lbl">Amount (R)</label><input name="amount" type="number" step="0.01" min="0.01" required value="' + esc(e.amount) + '"></div></div>' +
          '<div class="field"><label class="lbl">Description</label><input name="description" required maxlength="200" value="' + esc(e.description) + '"></div>' +
          '<div class="row"><div class="field"><label class="lbl">Category</label><select name="category">' + meta.expenseCategories.map(function (c) { return "<option" + (c === e.category ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field"><label class="lbl">Supplier</label><input name="supplier" maxlength="120" value="' + esc(e.supplier) + '"></div></div>' +
          '<div class="field"><label class="lbl">Type</label><select name="costType"><option value="business"' + (e.costType === "business" ? " selected" : "") + '>Business / startup (heat press, software, overheads)</option><option value="production"' + (e.costType === "production" ? " selected" : "") + ">Production / per-unit (stock, printing, packaging)</option></select>" +
          '<p class="hint">Either type counts towards total spend. Neither changes an order\'s print cost: that comes only from Unit costs.</p></div>' +
          '<div class="field"><label class="lbl">Notes (optional)</label><input name="notes" maxlength="1000" value="' + esc(e.notes) + '"></div>' +
          '<div class="field"><label class="lbl">Receipt (optional, PDF/JPG/PNG)' + (isEdit && e.receipt ? " · replaces the current one" : "") + '</label><input name="receipt" type="file" accept="application/pdf,image/jpeg,image/png"></div>',
        onSubmit: function (f) {
          if (!f.get("receipt") || !f.get("receipt").size) f.delete("receipt");
          return api("/finance/expenses" + (isEdit ? "/" + e.id : ""), { form: f }).then(function () { toast(isEdit ? "Expense updated" : "Expense added"); load(); });
        }
      });
    }
    function voidExpense(e) {
      if (e.voided) return api("/finance/expenses/" + e.id + "/void", { json: { voided: false } }).then(function () { toast("Expense restored"); load(); }).catch(fail);
      openModal({
        title: "Void this expense?",
        body: '<p class="muted small" style="margin-bottom:12px">Expenses are never deleted. A voided expense stays on record but is left out of the totals.</p><div class="field"><label class="lbl">Reason</label><input name="reason" maxlength="300" placeholder="e.g. entered twice"></div>',
        submit: "Void expense",
        onSubmit: function (f) { return api("/finance/expenses/" + e.id + "/void", { json: { voided: true, reason: f.get("reason") } }).then(function () { toast("Expense voided"); load(); }); }
      });
    }
    bindPeriod(load);
    ["#ex-cat", "#ex-type", "#ex-void"].forEach(function (s) { $(s).addEventListener("change", load); });
    $("#ex-add").addEventListener("click", function () { expenseModal(null); });
    return load();
  }

  function financeCosts(token, body) {
    return api("/finance/costs").then(function (d) {
      if (token !== renderToken) return;
      var rows = d.items.map(function (i) {
        return '<tr data-id="' + i.id + '"><td><input class="c-label" value="' + esc(i.label) + '" maxlength="80" aria-label="Cost name"><input class="c-note" value="' + esc(i.note) + '" maxlength="200" placeholder="Note" aria-label="Note" style="margin-top:6px;font-size:13px"></td>' +
          '<td style="width:130px"><input class="c-amount" type="number" step="0.01" min="0" value="' + i.amount.toFixed(2) + '" aria-label="Price each in rand"></td>' +
          '<td style="width:90px"><input class="c-qty" type="number" step="any" min="0.01" value="' + i.qty + '" aria-label="Quantity"></td>' +
          '<td class="r nowrap c-line">' + money(i.amount * i.qty) + "</td>" +
          '<td style="width:140px"><select class="c-basis" aria-label="Charged per"><option value="per_panel"' + (i.basis === "per_panel" ? " selected" : "") + '>per panel</option><option value="per_order"' + (i.basis === "per_order" ? " selected" : "") + ">per order</option></select></td>" +
          '<td class="nowrap"><button class="btn danger sm c-remove" type="button" aria-label="Remove ' + esc(i.label) + '">Remove</button></td></tr>';
      }).join("");
      body.innerHTML = '<div class="notice" style="margin-bottom:18px">These figures drive the estimated cost of <strong>new</strong> orders. Each order saves a snapshot of the costs that applied when it was placed, so changing a price here never alters past orders. Packaging and courier are charged <strong>once per order</strong>, not per panel.</div>' +
        '<form id="cost-form"><div class="tablewrap"><table class="tbl" style="min-width:760px"><thead><tr><th>Cost</th><th>Price each (R)</th><th>Qty</th><th class="r">Line total</th><th>Charged</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="actions" style="margin-top:16px"><button class="btn" type="submit">Save unit costs</button><button class="btn ghost" type="button" id="cost-add">Add a cost line</button></div></form>' +
        '<div class="section"><h2>Estimated cost per order</h2><div class="grid g-3"><div class="stat"><div class="l">Single (1 panel)</div><div class="n" id="cost-ex-1">' + money(d.examples[1]) + '</div></div><div class="stat"><div class="l">Duo (2 panels)</div><div class="n" id="cost-ex-2">' + money(d.examples[2]) + '</div></div><div class="stat"><div class="l">Quad (4 panels)</div><div class="n" id="cost-ex-4">' + money(d.examples[4]) + "</div></div></div>" +
        '<p class="hint">Every line in the list counts towards each new order. Remove a line if it no longer applies.</p></div>';
      $("#cost-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var items = $$("tr[data-id]", body).map(function (tr) {
          return { id: tr.getAttribute("data-id"), label: $(".c-label", tr).value, note: $(".c-note", tr).value, amount: $(".c-amount", tr).value, qty: $(".c-qty", tr).value, basis: $(".c-basis", tr).value };
        });
        api("/finance/costs", { json: { items: items } }).then(function () { toast("Unit costs saved"); return financeCosts(token, body); }).catch(fail);
      });
      // Live preview while typing: line totals and the per-order estimates (saved values are recalculated on the server).
      function recalc() {
        var ex = { 1: 0, 2: 0, 4: 0 };
        $$("tr[data-id]", body).forEach(function (tr) {
          var line = (parseFloat($(".c-amount", tr).value) || 0) * ($(".c-qty", tr).value === "" ? 1 : parseFloat($(".c-qty", tr).value) || 0);
          $(".c-line", tr).textContent = money(line);
          [1, 2, 4].forEach(function (n) { ex[n] += line * ($(".c-basis", tr).value === "per_panel" ? n : 1); });
        });
        [1, 2, 4].forEach(function (n) { $("#cost-ex-" + n).textContent = money(ex[n]); });
      }
      $("tbody", body).addEventListener("input", recalc);
      $("tbody", body).addEventListener("change", recalc);
      // Deletes on the server, then drops only that row so unsaved edits in other rows survive.
      $("tbody", body).addEventListener("click", function (e) {
        var btn = e.target.closest(".c-remove");
        if (!btn) return;
        var tr = btn.closest("tr[data-id]");
        confirmModal({
          title: "Remove cost line", danger: true, submit: "Remove",
          message: 'Remove "' + ($(".c-label", tr).value || "this cost line") + '"? Past orders keep the costs they were placed with.',
          onConfirm: function () {
            return api("/finance/costs/" + tr.getAttribute("data-id") + "/delete", { json: {} }).then(function (r) {
              tr.remove();
              recalc();
              toast("Cost line removed");
            });
          }
        });
      });
      $("#cost-add").addEventListener("click", function () {
        openModal({
          title: "Add a cost line", submit: "Add",
          body: '<div class="field"><label class="lbl">Name</label><input name="label" required maxlength="80"></div><div class="row"><div class="field"><label class="lbl">Price each (R)</label><input name="amount" type="number" step="0.01" min="0" value="0.00"></div><div class="field"><label class="lbl">Qty</label><input name="qty" type="number" step="any" min="0.01" value="1"></div><div class="field"><label class="lbl">Charged</label><select name="basis"><option value="per_panel">per panel</option><option value="per_order">per order</option></select></div></div>',
          onSubmit: function (f) { return api("/finance/costs/add", { json: fd(f) }).then(function () { toast("Cost line added"); financeCosts(token, body); }); }
        });
      });
    }).catch(fail);
  }

  /* ---------- inventory ---------- */
  function pageInventory(token) {
    return api("/inventory").then(function (d) {
      if (token !== renderToken) return;
      var rows = d.items.map(function (i) {
        return "<tr><td><strong>" + esc(i.name) + "</strong>" + (i.low ? ' ' + pill("p-pending", "Low stock") : "") + '<div class="muted small">Uses ' + (i.perPanel ? i.perPanel + " per panel" : "") + (i.perPanel && i.perOrder ? " + " : "") + (i.perOrder ? i.perOrder + " per order" : "") + '</div></td><td class="r"><strong>' + i.qty + " " + esc(i.unit) + '</strong></td><td class="r">' + (i.lowThreshold ? "warn at " + i.lowThreshold : "—") + '</td>' +
          '<td class="right nowrap"><button class="btn sm" type="button" data-adjust="' + i.id + '">Adjust stock</button> <button class="btn sm ghost" type="button" data-item="' + i.id + '">Edit</button> <button class="btn sm danger" type="button" data-remove="' + i.id + '">Remove</button></td></tr>';
      }).join("");
      var moves = d.movements.length ? '<div class="tablewrap"><table class="tbl"><thead><tr><th>When</th><th>Item</th><th class="r">Change</th><th>Reason</th></tr></thead><tbody>' + d.movements.map(function (m) {
        return '<tr><td class="nowrap">' + fmtDT(m.at) + "</td><td>" + esc(m.item) + '</td><td class="r ' + (m.delta < 0 ? "neg" : "pos") + '">' + (m.delta > 0 ? "+" : "") + m.delta + "</td><td>" + esc(m.reason) + (m.orderNumber ? ' <span class="muted small">' + esc(m.orderNumber) + "</span>" : "") + "</td></tr>";
      }).join("") + "</tbody></table></div>" : '<div class="tablewrap"><div class="empty">No stock movements yet.</div></div>';
      view.innerHTML = '<div class="page-head"><div><div class="eyebrow">Inventory</div><h1 class="page">Stock</h1></div><div class="actions"><button class="btn" type="button" id="inv-add">Add item</button></div></div>' +
        '<div class="notice" style="margin-bottom:18px">Stock is deducted automatically when an order reaches the stage chosen in <a href="#/settings">Settings</a>. Enter what you currently hold with <strong>Adjust stock</strong>.</div>' +
        '<div class="tablewrap"><table class="tbl"><thead><tr><th>Item</th><th class="r">On hand</th><th class="r">Low-stock warning</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="section"><h2>Recent movements</h2>' + moves + "</div>";
      $$("[data-adjust]", view).forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-adjust"), item = d.items.filter(function (x) { return String(x.id) === id; })[0];
          openModal({
            title: "Adjust " + item.name, submit: "Save adjustment",
            body: '<p class="muted small" style="margin-bottom:12px">Currently ' + item.qty + " " + esc(item.unit) + '. Enter a positive number to add stock, or a negative number to remove it.</p><div class="field"><label class="lbl">Change</label><input name="delta" type="number" step="any" required placeholder="e.g. 50 or -3"></div><div class="field"><label class="lbl">Reason</label><input name="reason" maxlength="200" placeholder="e.g. delivery from supplier"></div>',
            onSubmit: function (f) { return api("/inventory/" + id + "/adjust", { json: fd(f) }).then(function () { toast("Stock updated"); pageInventory(renderToken); }); }
          });
        });
      });
      $$("[data-item]", view).forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-item"), item = d.items.filter(function (x) { return String(x.id) === id; })[0];
          openModal({
            title: "Edit " + item.name, submit: "Save",
            body: '<div class="row"><div class="field"><label class="lbl">Name</label><input name="name" required maxlength="80" value="' + esc(item.name) + '"></div><div class="field" style="max-width:140px"><label class="lbl">Unit</label><input name="unit" required maxlength="20" value="' + esc(item.unit) + '"></div></div><div class="field"><label class="lbl">Warn when stock falls to</label><input name="lowThreshold" type="number" min="0" step="any" value="' + item.lowThreshold + '"><p class="hint">Use 0 for no warning.</p></div>' +
              '<div class="row"><div class="field"><label class="lbl">Used per panel</label><input name="perPanel" type="number" min="0" step="any" value="' + item.perPanel + '"></div><div class="field"><label class="lbl">Used per order</label><input name="perOrder" type="number" min="0" step="any" value="' + item.perOrder + '"></div></div>',
            onSubmit: function (f) { return api("/inventory/" + id, { json: fd(f) }).then(function () { toast("Item saved"); pageInventory(renderToken); }); }
          });
        });
      });
      $$("[data-remove]", view).forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-remove"), item = d.items.filter(function (x) { return String(x.id) === id; })[0];
          confirmModal({
            title: "Remove item", danger: true, submit: "Remove",
            message: 'Remove "' + item.name + '" and its stock history? It will no longer be deducted for new orders. Orders themselves are not affected.',
            onConfirm: function () { return api("/inventory/" + id + "/delete", { json: {} }).then(function () { toast("Item removed"); pageInventory(renderToken); }); }
          });
        });
      });
      $("#inv-add").addEventListener("click", function () {
        openModal({
          title: "Add an inventory item", submit: "Add item",
          body: '<div class="row"><div class="field"><label class="lbl">Name</label><input name="name" required maxlength="80" placeholder="e.g. Foam pieces"></div><div class="field" style="max-width:140px"><label class="lbl">Unit</label><input name="unit" required maxlength="20" value="pcs"></div></div>' +
            '<div class="row"><div class="field"><label class="lbl">Stock on hand now</label><input name="qty" type="number" min="0" step="any" value="0"></div><div class="field"><label class="lbl">Warn when stock falls to</label><input name="lowThreshold" type="number" min="0" step="any" value="0"></div></div>' +
            '<div class="row"><div class="field"><label class="lbl">Used per panel</label><input name="perPanel" type="number" min="0" step="any" value="0"></div><div class="field"><label class="lbl">Used per order</label><input name="perOrder" type="number" min="0" step="any" value="0"></div></div>' +
            '<p class="hint">"Used per panel / per order" is how much is deducted automatically for each order, e.g. 2 foam pieces per order. Use 0 for items you only track by hand. A warning of 0 means no low-stock warning.</p>',
          onSubmit: function (f) { return api("/inventory/add", { json: fd(f) }).then(function () { toast("Item added"); pageInventory(renderToken); }); }
        });
      });
    });
  }

  /* ---------- pricing ---------- */
  // One price per panel + a per-order handling charge (customers see free delivery) + volume discounts.
  // The preview uses window.VantaPricing, the same rules the shop and the server use.
  function pagePricing(token) {
    return api("/pricing").then(function (d) {
      if (token !== renderToken) return;
      function tierRow(t) {
        return '<tr class="tier"><td><input class="t-min" type="number" min="2" step="1" required value="' + (t ? t.minPanels : "") + '" aria-label="From this many panels"></td>' +
          '<td><input class="t-pct" type="number" min="0.01" max="99.99" step="0.01" required value="' + (t ? t.pct : "") + '" aria-label="Discount percent"></td>' +
          '<td class="r nowrap t-each"></td><td class="r"><button class="btn danger sm t-remove" type="button">Remove</button></td></tr>';
      }
      view.innerHTML = '<div class="page-head"><div><div class="eyebrow">Pricing</div><h1 class="page">Pricing</h1></div></div>' +
        '<form id="pricing-form" class="stack">' +
        '<section class="card"><h2>Price</h2><div class="row">' +
        '<div class="field"><label class="lbl" for="p-price">Price per A4 panel (R)</label><input id="p-price" type="number" step="0.01" min="0.01" required value="' + (d.pricePerPanelCents / 100).toFixed(2) + '"></div>' +
        '<div class="field"><label class="lbl" for="p-handling">Delivery &amp; handling per order (R)</label><input id="p-handling" type="number" step="0.01" min="0" required value="' + (d.handlingCents / 100).toFixed(2) + '"></div></div>' +
        '<p class="hint">Every panel costs the same, whatever the layout. Delivery &amp; handling is charged <strong>once per order</strong> and never discounted. Customers see every panel advertised at <strong id="p-one"></strong> (price + delivery &amp; handling) with free delivery; from the second panel on, the delivery &amp; handling they do not pay again shows as a <strong>multi-panel discount</strong>.</p></section>' +
        // Special offer: lower price per panel until the end of its last day (SA time), then it switches itself off.
        '<section class="card"><h2>Special offer</h2><div class="row">' +
        '<div class="field"><label class="lbl" for="p-promo-name">Name shown to customers</label><input id="p-promo-name" maxlength="40" value="' + esc(d.promo.name || "Launch special") + '"></div>' +
        '<div class="field"><label class="lbl" for="p-promo-price">Special price per panel (R)</label><input id="p-promo-price" type="number" step="0.01" min="0" placeholder="Leave empty for no special" value="' + (d.promo.pricePerPanelCents ? (d.promo.pricePerPanelCents / 100).toFixed(2) : "") + '"></div>' +
        '<div class="field"><label class="lbl" for="p-promo-day">Last day of the special</label><input id="p-promo-day" type="date" value="' + (d.promo.endsAt ? new Date(Date.parse(d.promo.endsAt) - 1).toLocaleDateString("en-CA", { timeZone: TZ }) : "") + '"></div></div>' +
        '<p class="hint" id="p-promo-status"></p></section>' +
        '<section class="card"><h2>Volume discounts</h2>' +
        '<p class="hint" style="margin-bottom:14px">Counted on the total number of panels in an order, across every print and every copy. The discount comes off the panel price only, never off delivery &amp; handling.</p>' +
        '<div class="tablewrap"><table class="tbl" style="min-width:560px"><thead><tr><th>From (panels)</th><th>Discount (%)</th><th class="r">Panel price after discount</th><th></th></tr></thead><tbody id="tiers">' +
        d.tiers.map(tierRow).join("") + '</tbody></table></div>' +
        '<div class="actions" style="margin-top:12px"><button class="btn ghost sm" type="button" id="tier-add">Add a discount level</button></div></section>' +
        '<section class="card"><h2>What customers pay</h2><div class="tablewrap"><table class="tbl" style="min-width:900px"><thead><tr><th>Panels</th><th class="r">Advertised</th><th class="r">Special</th><th class="r">Multi-panel discount</th><th class="r">Volume discount</th><th class="r">Customer pays</th><th class="r">Est. cost</th><th class="r">Est. profit</th></tr></thead><tbody id="preview"></tbody></table></div>' +
        '<p class="hint">Est. cost comes from <a href="#/finance/costs">Finance &rarr; Unit costs</a> (per-panel lines × panels, plus per-order lines once).</p></section>' +
        '<div><button class="btn" type="submit">Save pricing</button></div></form>';

      function readCfg() {
        var tiers = $$("#tiers tr.tier").map(function (tr) { return { minPanels: parseInt($(".t-min", tr).value, 10), pct: parseFloat($(".t-pct", tr).value) }; })
          .filter(function (t) { return t.minPanels >= 2 && t.pct > 0 && t.pct < 100; });
        var day = $("#p-promo-day").value, promoPrice = Math.round((parseFloat($("#p-promo-price").value) || 0) * 100);
        var promo = promoPrice && day ? { name: $("#p-promo-name").value || "Special", pricePerPanelCents: promoPrice, endsAt: new Date(Date.parse(day + "T00:00:00+02:00") + 864e5).toISOString() } : null;
        return { pricePerPanelCents: Math.round((parseFloat($("#p-price").value) || 0) * 100), handlingCents: Math.round((parseFloat($("#p-handling").value) || 0) * 100), tiers: tiers, promo: promo };
      }
      function recalc() {
        var cfg = readCfg();
        $("#p-one").textContent = money(VantaPricing.quote(1, cfg).advertisedPerPanelCents / 100);
        var running = VantaPricing.activePromo(cfg);
        $("#p-promo-status").innerHTML = !cfg.promo ? "No special set. Leave the price empty for none."
          : running ? "<strong>Running now.</strong> Customers pay " + money((cfg.promo.pricePerPanelCents + cfg.handlingCents) / 100) + " per panel instead of " + money(VantaPricing.quote(1, cfg).advertisedPerPanelCents / 100) + " until the end of " + fmtDay($("#p-promo-day").value) + ", then it switches off by itself and every advert for it disappears. The preview below includes it."
          : "This special has ended (or the date is in the past). Normal prices apply.";
        $$("#tiers tr.tier").forEach(function (tr) {
          var pct = parseFloat($(".t-pct", tr).value) || 0;
          $(".t-each", tr).textContent = money(Math.round(cfg.pricePerPanelCents * (100 - pct) / 100) / 100);
        });
        var counts = [1, 4];
        cfg.tiers.forEach(function (t) { counts.push(t.minPanels - 1, t.minPanels); });
        counts = counts.filter(function (n, i, a) { return n >= 1 && a.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
        $("#preview").innerHTML = counts.map(function (n) {
          var q = VantaPricing.quote(n, cfg);
          var cost = n * d.costPerPanelCents + d.costPerOrderCents, profit = q.totalCents - cost;
          return "<tr><td>" + n + '</td><td class="r nowrap">' + n + ' × ' + money(q.advertisedPerPanelCents / 100) + ' = ' + money(q.advertisedCents / 100) + '</td><td class="r nowrap">' + (q.promoSavingCents ? '−' + money(q.promoSavingCents / 100) : '—') + '</td><td class="r nowrap">' + (q.multiPanelSavingCents ? '−' + money(q.multiPanelSavingCents / 100) : '—') + '</td><td class="r nowrap">' + (q.discountPct ? q.discountPct + '% · −' + money(q.discountCents / 100) : '—') +
            '</td><td class="r nowrap"><strong>' + money(q.totalCents / 100) + '</strong></td><td class="r nowrap muted">' + money(cost / 100) + '</td><td class="r nowrap ' + (profit < 0 ? "neg" : "pos") + '">' + money(profit / 100) + "</td></tr>";
        }).join("");
      }
      $("#pricing-form").addEventListener("input", recalc);
      $("#tiers").addEventListener("click", function (e) {
        var b = e.target.closest(".t-remove");
        if (b) { b.closest("tr").remove(); recalc(); }
      });
      $("#tier-add").addEventListener("click", function () {
        $("#tiers").insertAdjacentHTML("beforeend", tierRow(null));
        $("#tiers tr.tier:last-child .t-min").focus();
      });
      recalc();
      $("#pricing-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var tiers = $$("#tiers tr.tier").map(function (tr) { return { minPanels: $(".t-min", tr).value, pct: $(".t-pct", tr).value }; });
        api("/pricing", { json: { pricePerPanel: $("#p-price").value, handling: $("#p-handling").value, tiers: tiers, promoName: $("#p-promo-name").value, promoPrice: $("#p-promo-price").value, promoLastDay: $("#p-promo-day").value } })
          .then(function () { toast("Pricing saved"); return pagePricing(token); }).catch(fail);
      });
    });
  }

  /* ---------- settings ---------- */
  function pageSettings(token) {
    return api("/settings").then(function (s) {
      if (token !== renderToken) return;
      function txt(name, label, val, area) {
        return '<div class="field"><label class="lbl" for="s-' + name + '">' + label + "</label>" + (area ? '<textarea id="s-' + name + '" name="' + name + '" maxlength="500" style="min-height:80px">' + esc(val) + "</textarea>" : '<input id="s-' + name + '" name="' + name + '" maxlength="200" value="' + esc(val) + '">') + "</div>";
      }
      view.innerHTML = '<div class="page-head"><div><div class="eyebrow">Settings</div><h1 class="page">Settings</h1></div></div>' +
        '<form id="settings-form" class="stack">' +
        '<div class="notice">Customer prices are set under <a href="#/pricing">Pricing</a>.</div>' +
        '<section class="card"><h2>Production &amp; costs</h2><div class="field"><label class="lbl" for="s-deduct">Deduct stock when an order reaches</label><select id="s-deduct" name="deductStockOn"><option value="in_production"' + (s.deductStockOn === "in_production" ? " selected" : "") + '>In Production</option><option value="completed"' + (s.deductStockOn === "completed" ? " selected" : "") + '>Completed</option><option value="off"' + (s.deductStockOn === "off" ? " selected" : "") + '>Never (I\'ll adjust stock by hand)</option></select></div>' +
        '<p class="hint">Unit costs (aluminium, printing, magnets and so on) are edited under <a href="#/finance/costs">Finance &rarr; Unit costs</a>.</p>' +
        '<div class="notice" style="margin-top:14px">Order workflow: ' + meta.statuses.filter(function (x) { return PIPE.indexOf(x.key) >= 0; }).map(function (x) { return esc(x.label); }).join(" → ") + ". Cancelled and Refunded are available where needed.</div></section>" +
        '<section class="card"><h2>Business &amp; invoice details</h2><div class="row">' + txt("business_name", "Trading name", s.business_name) + txt("business_legal_name", "Registered name (optional)", s.business_legal_name) + "</div>" +
        txt("business_address", "Address", s.business_address, true) + '<div class="row">' + txt("business_email", "Email", s.business_email) + txt("business_phone", "Phone", s.business_phone) + txt("vat_number", "VAT number (optional)", s.vat_number) + "</div>" +
        txt("bank_details", "Bank details (shown on unpaid invoices)", s.bank_details, true) + txt("invoice_notes", "Invoice footer note", s.invoice_notes, true) + "</section>" +
        // Order notification emails: who gets them, and the (Gmail) account that sends them.
        '<section class="card"><h2>Order notifications</h2>' +
        '<p class="hint" style="margin-bottom:12px">Get an email every time an order is paid online, so you never miss one. The sending account\'s app password is kept only on this server and is never shown again.</p>' +
        '<div class="field"><label class="lbl" for="s-notify">Send notifications to</label><input id="s-notify" name="notifyEmail" type="text" maxlength="300" autocomplete="email" placeholder="you@gmail.com (separate several with commas)" value="' + esc(s.notifyEmail) + '"></div>' +
        '<div class="row"><div class="field"><label class="lbl" for="s-smtp-user">Send from (Gmail address)</label><input id="s-smtp-user" name="smtpUser" type="email" maxlength="160" autocomplete="off" placeholder="you@gmail.com" value="' + esc(s.smtpUser) + '"></div>' +
        '<div class="field"><label class="lbl" for="s-smtp-pass">Gmail app password</label><input id="s-smtp-pass" name="smtpPass" type="password" maxlength="200" autocomplete="new-password" placeholder="' + (s.smtpPassSet ? "Saved. Leave empty to keep it" : "16 letters from Google") + '"></div></div>' +
        '<details style="margin:2px 0 12px"><summary class="muted small" style="cursor:pointer">How to get a Gmail app password</summary><ol class="hint" style="margin:8px 0 0 18px;line-height:1.7">' +
        '<li>Turn on 2-Step Verification for the Gmail account (Google Account &rarr; Security).</li>' +
        '<li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>, name it "VANTA" and click Create.</li>' +
        '<li>Copy the 16-letter password into the field above and save. Your normal Gmail password is never used.</li></ol></details>' +
        '<details style="margin:0 0 12px"><summary class="muted small" style="cursor:pointer">Not using Gmail?</summary><div class="row" style="margin-top:8px"><div class="field"><label class="lbl" for="s-smtp-host">SMTP server</label><input id="s-smtp-host" name="smtpHost" maxlength="120" value="' + esc(s.smtpHost) + '"></div>' +
        '<div class="field" style="max-width:140px"><label class="lbl" for="s-smtp-port">Port</label><input id="s-smtp-port" name="smtpPort" type="number" min="1" max="65535" value="' + s.smtpPort + '"></div></div></details>' +
        '<p class="hint">' + (s.notifyEmail && s.smtpUser && s.smtpPassSet ? "<strong>On.</strong> Order emails go to " + esc(s.notifyEmail) + "." : "<strong>Off.</strong> Fill in all three fields and save to turn it on.") + "</p>" +
        (s.notifyEmail && s.smtpUser && s.smtpPassSet ? '<div style="margin-top:10px"><button class="btn ghost sm" type="button" id="notify-test-btn">Send a test email</button></div>' : "") +
        "</section>" +
        // Online payments: keys are stored only on this server; the secret is never shown again once saved.
        '<section class="card"><h2>Online payments (iKhokha)</h2>' +
        (s.ikhokhaFromEnv ? '<div class="notice">Keys are set on the server itself, so the fields below are not used.</div>'
          : '<p class="hint" style="margin-bottom:12px">From your iKhokha dashboard: <strong>iK Pay API</strong> &rarr; <strong>Generate New IK API Key</strong>. Paste the two values here and save. The secret is kept only on this server and is never shown again.</p>' +
            '<div class="row"><div class="field"><label class="lbl" for="s-ik-id">Application ID</label><input id="s-ik-id" name="ikhokhaAppId" maxlength="100" autocomplete="off" value="' + esc(s.ikhokhaAppId) + '"></div>' +
            '<div class="field"><label class="lbl" for="s-ik-secret">Application secret</label><input id="s-ik-secret" name="ikhokhaSecret" type="password" maxlength="200" autocomplete="new-password" placeholder="' + (s.ikhokhaSecretSet ? "Saved. Leave empty to keep it" : "Paste the secret") + '"></div></div>') +
        '<p class="hint" id="ik-status">' + (s.ikhokhaFromEnv || (s.ikhokhaAppId && s.ikhokhaSecretSet) ? "<strong>Connected.</strong> Customers pay by card on iKhokha's secure page, and paid orders are marked automatically."
          : "<strong>Not connected.</strong> Orders are taken without payment until both keys are saved.") + "</p>" +
        (!s.ikhokhaFromEnv && (s.ikhokhaAppId || s.ikhokhaSecretSet) ? '<label class="check" style="margin-top:6px"><input type="checkbox" name="ikhokhaClear" value="1"> Remove the saved keys (turns online payment off)</label>' : "") +
        (s.ikhokhaFromEnv || (s.ikhokhaAppId && s.ikhokhaSecretSet) ? '<div class="section" style="margin-top:16px"><h3 style="font:600 16px var(--display);margin-bottom:8px">Test payment</h3><p class="hint" style="margin-bottom:10px">iKhokha has no test mode, so this is a real card payment. Make a small one to check everything works, then refund it in your iKhokha dashboard.</p>' +
          '<div class="row" style="align-items:flex-end"><div class="field" style="max-width:160px"><label class="lbl" for="s-ik-test">Amount (R)</label><input id="s-ik-test" type="number" min="1" max="50" step="1" value="5"></div><div class="field"><button class="btn ghost" type="button" id="ik-test-btn">Create test payment link</button></div></div><div id="ik-test-out" class="hint"></div></div>' : "") +
        "</section>" +
        '<div><button class="btn" type="submit">Save settings</button></div></form>';
      $("#settings-form").addEventListener("submit", function (e) {
        e.preventDefault();
        api("/settings", { json: fd(new FormData(e.target)) }).then(function () { toast("Settings saved"); pageSettings(renderToken); }).catch(fail);
      });
      var notifyBtn = $("#notify-test-btn");
      if (notifyBtn) notifyBtn.addEventListener("click", function () {
        notifyBtn.disabled = true;
        api("/notifications/test", { json: {} }).then(function () { toast("Test email sent. Check your inbox"); }).catch(fail).then(function () { notifyBtn.disabled = false; });
      });
      var testBtn = $("#ik-test-btn");
      if (testBtn) testBtn.addEventListener("click", function () {
        testBtn.disabled = true;
        api("/payments/test", { json: { amount: $("#s-ik-test").value } }).then(function (r) {
          var out = $("#ik-test-out");
          out.innerHTML = 'Test link ready: <a href="' + esc(r.paylinkUrl) + '" target="_blank" rel="noopener">open the payment page</a> and pay with your card. Then <button class="btn sm ghost" type="button" id="ik-test-check">Check its status</button> <span id="ik-test-status"></span>';
          $("#ik-test-check").addEventListener("click", function () {
            api("/payments/test/" + encodeURIComponent(r.paylinkID)).then(function (st) {
              $("#ik-test-status").textContent = "iKhokha says: " + (st && st.status ? st.status : "unknown") + (st && st.amount != null ? " (" + money(st.amount / 100) + ")" : "") + ".";
            }).catch(fail);
          });
        }).catch(fail).then(function () { testBtn.disabled = false; });
      });
    });
  }

  /* ---------- router ---------- */
  function route() {
    var raw = location.hash.replace(/^#/, "") || "/";
    var parts = raw.split("?"), path = parts[0], query = {};
    new URLSearchParams(parts[1] || "").forEach(function (v, k) { query[k] = v; });
    var seg = path.split("/").filter(Boolean);
    var token = ++renderToken;
    var page = seg[0] || "dashboard";
    $$("#nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-nav") === page); });
    $("#side").classList.remove("open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");

    var p;
    if (page === "dashboard") p = pageDashboard(token);
    else if (page === "orders" && seg[1]) p = pageOrder(token, parseInt(seg[1], 10));
    else if (page === "orders") p = pageOrders(token, query);
    else if (page === "customer" && seg[1]) p = pageCustomer(token, decodeURIComponent(seg[1]));
    else if (page === "finance") p = pageFinance(token, seg[1]);
    else if (page === "pricing") p = pagePricing(token);
    else if (page === "inventory") p = pageInventory(token);
    else if (page === "settings") p = pageSettings(token);
    else { location.hash = "#/"; return; }
    if (!(seg[0] === "orders" && !seg[1])) window.scrollTo(0, 0);
    Promise.resolve(p).catch(function (err) {
      if (token === renderToken) view.innerHTML = '<div class="card"><p>' + esc(err.message || "Couldn't load this page.") + '</p><p><a href="#/">Back to dashboard</a></p></div>';
    });
  }

  view.addEventListener("click", function (e) {
    if (e.target.closest("a, button, input, select, textarea, label")) return;
    var row = e.target.closest("tr[data-href]");
    if (row) location.hash = row.getAttribute("data-href");
  });
  $("#menu-toggle").addEventListener("click", function () {
    var open = $("#side").classList.toggle("open");
    this.setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("#logout").addEventListener("click", function () {
    api("/logout", { json: {} }).then(function () { location.reload(); }).catch(function () { location.reload(); });
  });
  window.addEventListener("hashchange", route);

  api("/session").then(function (s) { csrf = s.csrf; meta = s; route(); }).catch(function () { /* reload handled in api() on 401 */ });
})();
