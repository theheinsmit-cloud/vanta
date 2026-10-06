/* Where customers land after iKhokha's payment page (?order=<checkout ref>&t=<private token>&r=success|failed|cancelled).
   The "r" value only sets the first message: whether the order is paid always comes from our server,
   which confirms it with iKhokha. On success we poll for a short while, since the confirmation can lag. */
(function(){
  "use strict";
  var q = new URLSearchParams(location.search);
  var order = q.get("order"), token = q.get("t"), result = q.get("r"), isTest = q.get("test") === "1";
  var el = function(id){ return document.getElementById(id); };
  var rands = function(c){ return "R" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  function show(title, text, detail, canRetry){
    el("pay-title").textContent = title;
    el("pay-text").textContent = text;
    el("pay-detail").textContent = detail || "";
    el("pay-again").hidden = !canRetry;
  }

  if (isTest){
    show(result === "success" ? "Test payment done." : "Test payment not completed.",
      result === "success" ? "Check its status in the admin, then refund it in your iKhokha dashboard." : "You can create a new test link in the admin Settings.", "", false);
    return;
  }
  if (!token){
    show("We couldn't find that order.", "Please use the link from your payment page, or get in touch with us on Instagram.", "", false);
    return;
  }

  var tries = 0;
  function poll(){
    tries++;
    fetch("/api/payments/status?order=" + encodeURIComponent(order) + "&t=" + encodeURIComponent(token) + "&check=1", { cache: "no-store" })
      .then(function(r){ return r.json().then(function(d){ if (!r.ok) throw new Error(d.error || "Not found"); return d; }); })
      .then(function(s){
        var summary = s.panels + " panel" + (s.panels === 1 ? "" : "s") + ", " + rands(s.totalCents) + ".";
        if (s.paid){
          el("pay-eyebrow").textContent = "Payment received";
          el("pay-ref").textContent = "Order reference: " + s.orderNumber;   // a real order number only exists once paid
          show("Thank you, your order is paid.", "We've received your payment and your order is now in our production queue. We'll be in touch when it ships.", summary, false);
          return;
        }
        if (result === "success" && tries < 8){   // paid on iKhokha, confirmation still on its way
          show("Confirming your payment…", "Your payment went through. We're just waiting for iKhokha to confirm it, this usually takes a few seconds.", summary, false);
          setTimeout(poll, 3000);
          return;
        }
        if (result === "success"){
          show("We're still confirming your payment.", "If your card was charged, there's nothing more to do: we'll confirm it on our side shortly. If you're unsure, please don't pay again: get in touch with us on Instagram.", summary, false);
          return;
        }
        show(result === "cancelled" ? "Payment cancelled." : "Payment didn't go through.",
          "Your order isn't placed until payment goes through. Your prints are saved, so you can try again below.", summary, s.canPay);
      })
      .catch(function(){ show("We couldn't find that order.", "Please use the link from your payment page, or get in touch with us on Instagram.", "", false); });
  }
  poll();

  el("pay-again").addEventListener("click", function(){
    var b = this; b.disabled = true; b.textContent = "Opening payment page…";
    fetch("/api/payments/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: order, token: token }) })
      .then(function(r){ return r.json().then(function(d){ if (!r.ok || !d.payUrl) throw new Error(d.error || "We couldn't open the payment page."); location.href = d.payUrl; }); })
      .catch(function(err){ b.disabled = false; b.textContent = "Try payment again"; vantaDialog({ title: "Payment page didn't open", message: err.message }); });
  });
})();
