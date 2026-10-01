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
