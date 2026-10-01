(function(){
  "use strict";

  /* nav: solid background after scrolling past the hero fold */
  var nav = document.querySelector(".site-nav");
  if (nav){
    var onNavScroll = function(){
      nav.classList.toggle("scrolled", window.scrollY > 60);
    };
    addEventListener("scroll", onNavScroll, { passive:true });
    onNavScroll();

    var toggle = document.querySelector(".nav-toggle");
    var links = document.querySelector(".nav-links");
    if (toggle && links){
      toggle.addEventListener("click", function(){
        var open = links.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      links.querySelectorAll("a").forEach(function(a){
        a.addEventListener("click", function(){ links.classList.remove("open"); });
      });
    }
  }

  /* pause all CSS animations on hidden tabs */
  document.addEventListener("visibilitychange", function(){
    document.body.classList.toggle("paused", document.hidden);
  });

  /* entrance choreography for below-fold content */
  var targets = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && targets.length){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting){
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold:0.16, rootMargin:"0px 0px -8% 0px" });
    targets.forEach(function(el){ io.observe(el); });
  } else {
    targets.forEach(function(el){ el.classList.add("in"); });
  }

  /* lightbox: click any gallery tile to enlarge it */
  var lightbox = document.getElementById("lightbox");
  if (lightbox){
    var lbImg = lightbox.querySelector(".lightbox-figure img");
    var lbCaption = lightbox.querySelector(".lightbox-caption");
    var lbClose = lightbox.querySelector(".lightbox-close");
    var lastFocused = null;

    function openLightbox(src, alt, caption){
      lbImg.src = src;
      lbImg.alt = alt || "";
      lbCaption.textContent = caption || "";
      lastFocused = document.activeElement;
      lightbox.classList.add("open");
      document.body.classList.add("lightbox-locked");
      lbClose.focus();
    }
    function closeLightbox(){
      lightbox.classList.remove("open");
      document.body.classList.remove("lightbox-locked");
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    document.querySelectorAll(".gallery-tile").forEach(function(tile){
      tile.addEventListener("click", function(e){
        var img = tile.querySelector("img");
        if (!img) return;
        e.preventDefault();
        var captionEl = tile.querySelector(".caption");
        openLightbox(img.src, img.alt, captionEl ? captionEl.textContent : "");
      });
    });

    lightbox.addEventListener("click", function(e){
      if (e.target === lightbox) closeLightbox();
    });
    lbClose.addEventListener("click", closeLightbox);
    document.addEventListener("keydown", function(e){
      if (e.key === "Escape" && lightbox.classList.contains("open")) closeLightbox();
    });
  }

  /* special offer (e.g. the launch special): advertised only while it runs, according to /api/pricing.
     Fills the [data-promo-badge] and [data-promo-section] slots, adds a dismissible bar on other pages,
     and removes everything by itself the moment the offer ends, even on a page left open. */
  if (window.VantaPricing){
    fetch("/api/pricing", { cache: "no-store" }).then(function(r){ return r.ok ? r.json() : null; }).then(function(p){
      var promo = p && VantaPricing.activePromo(p);
      if (!promo) return;
      var rands = function(c){ return "R" + (c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }); };
      var now = rands(promo.pricePerPanelCents + p.handlingCents), was = rands(p.pricePerPanelCents + p.handlingCents);
      var until = VantaPricing.promoLastDay(promo);
      var added = [];
      function make(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
      function priceLine(target){
        target.appendChild(make("span", "promo-tag", promo.name));
        target.appendChild(document.createTextNode(" " + now + " per panel, normally "));
        target.appendChild(make("s", null, was));
        target.appendChild(document.createTextNode(". Until " + until + "."));
      }

      document.querySelectorAll("[data-promo-badge]").forEach(function(slot){ priceLine(slot); slot.hidden = false; added.push(slot); });

      document.querySelectorAll("[data-promo-section]").forEach(function(slot){
        var tiers = (p.tiers || []).map(function(t){ return t.pct + "% off " + t.minPanels + "+ panels"; }).join(", ");
        var wrap = make("div", "wrap promo-grid");
        var copy = make("div", "promo-copy");
        copy.appendChild(make("p", "eyebrow", promo.name));
        var h = make("h2", null, now + " per panel."); h.id = "promo-head";
        h.appendChild(document.createElement("br")); h.appendChild(document.createTextNode("Until " + until + "."));
        copy.appendChild(h);
        copy.appendChild(make("p", null, "Every A4 metal panel for " + now + " instead of " + was + ", with free nationwide delivery." + (tiers ? " Volume discounts still apply on top: " + tiers + "." : "")));
        var cta = make("a", "btn btn-primary", "Create your VANTA"); cta.href = "create.html";
        copy.appendChild(cta);
        var price = make("div", "promo-price"); price.setAttribute("aria-hidden", "true");
        var art = make("img", "promo-art"); art.src = "assets/promo-launch.jpg"; art.alt = ""; art.loading = "lazy";
        price.appendChild(art);
        price.appendChild(make("s", "was", was)); price.appendChild(make("span", "now", now)); price.appendChild(make("span", "per", "per A4 panel"));
        wrap.appendChild(copy); wrap.appendChild(price);
        slot.className = "band-y promo-band"; slot.setAttribute("aria-labelledby", "promo-head");
        slot.appendChild(wrap); slot.hidden = false; added.push(slot);
      });

      // Floating bar everywhere except the Create page, which shows the offer in its order summary.
      var dismissed = false;
      try { dismissed = sessionStorage.getItem("vanta-promo-closed") === promo.endsAt; } catch (e) { /* storage blocked: show it */ }
      if (!document.getElementById("order-form") && !dismissed){
        var bar = make("div", "promo-bar"); bar.setAttribute("role", "region"); bar.setAttribute("aria-label", promo.name);
        var text = make("p"); priceLine(text); bar.appendChild(text);
        var go = make("a", "promo-bar-cta", "Create yours"); go.href = "create.html"; bar.appendChild(go);
        var close = make("button", "promo-bar-close", "×"); close.type = "button"; close.setAttribute("aria-label", "Hide this offer");
        close.addEventListener("click", function(){
          bar.remove();
          try { sessionStorage.setItem("vanta-promo-closed", promo.endsAt); } catch (e) { /* ignore */ }
        });
        bar.appendChild(close);
        document.body.appendChild(bar); added.push(bar);
      }

      var left = Date.parse(promo.endsAt) - Date.now();
      if (left < 2147483647) setTimeout(function(){
        added.forEach(function(n){ if (n.hasAttribute("data-promo-badge") || n.hasAttribute("data-promo-section")){ n.hidden = true; n.innerHTML = ""; } else n.remove(); });
      }, left);
    }).catch(function(){ /* no offer shown if pricing can't load */ });
  }

  /* on-brand message dialog: use instead of the browser's alert()/confirm().
     vantaDialog({ title, message, ok, cancel }) returns a promise that resolves
     true for the main button, false for cancel/Escape/backdrop. */
  window.vantaDialog = function(o){
    if (typeof o === "string") o = { message:o };
    return new Promise(function(resolve){
      var prev = document.activeElement;
      var wrap = document.createElement("div");
      wrap.className = "vd-backdrop";
      var box = document.createElement("div");
      box.className = "vd";
      box.setAttribute("role", o.cancel ? "alertdialog" : "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "vd-title");
      box.setAttribute("aria-describedby", "vd-msg");
      var h = document.createElement("h2"); h.id = "vd-title"; h.className = "vd-title"; h.textContent = o.title || "VANTA";
      var p = document.createElement("p"); p.id = "vd-msg"; p.className = "vd-msg"; p.textContent = o.message || "";
      var actions = document.createElement("div"); actions.className = "vd-actions";
      var okBtn = document.createElement("button"); okBtn.type = "button"; okBtn.className = "btn btn-primary"; okBtn.textContent = o.ok || "OK";
      if (o.cancel){
        var cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.className = "btn btn-ghost"; cancelBtn.textContent = o.cancel;
        cancelBtn.addEventListener("click", function(){ done(false); });
        actions.appendChild(cancelBtn);
      }
      actions.appendChild(okBtn);
      box.appendChild(h); box.appendChild(p); box.appendChild(actions);
      wrap.appendChild(box);
      function onKey(e){
        if (e.key === "Escape") done(false);
        else if (e.key === "Tab"){ // keep focus inside the dialog
          var f = actions.querySelectorAll("button"), first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
        }
      }
      function done(v){
        document.removeEventListener("keydown", onKey);
        wrap.classList.remove("open");
        setTimeout(function(){ wrap.remove(); }, 250);
        if (prev && prev.focus) prev.focus();
        resolve(v);
      }
      okBtn.addEventListener("click", function(){ done(true); });
      wrap.addEventListener("mousedown", function(e){ if (e.target === wrap) done(false); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(wrap);
      requestAnimationFrame(function(){ wrap.classList.add("open"); });
      okBtn.focus();
    });
  };
})();
