(function(){
  "use strict";

  var stage = document.querySelector(".hero-stage");
  var pin = document.querySelector(".hero-pin");
  if (!stage || !pin) return;

  var video = document.getElementById("hero-video");
  var canvas = document.getElementById("hero-canvas");
  var ctx = canvas.getContext("2d");
  var posterLayer = stage.querySelector(".hero-poster");
  var ring = stage.querySelector(".hero-loading .ring");
  var reveal = stage.querySelector(".hero-reveal");
  var revealImgs = Array.prototype.slice.call(reveal.querySelectorAll("img"));
  var band = stage.querySelector(".hero-band");
  var bandKicker = band.querySelector(".kicker");
  var bandTitle = band.querySelector("h2");
  var introEl = stage.querySelector(".hero-intro");
  var settleEl = stage.querySelector(".hero-settle");
  var cueEl = stage.querySelector(".hero-cue");

  var VIDEO_URL = "assets/hero-scrub.mp4";

  /* the panel's box inside the raw 1920x1080 hero frame, read off the approved footage */
  var PANEL_BOX = { left: 770/1920, top: 82/1080, width: 380/1920, height: 923/1080 };

  var CYCLES = [
    { key:"automotive", img:"assets/showcase-automotive.jpg", kicker:"Automotive", title:"Your car, permanent.",
      riseStart:0.06, riseEnd:0.15, holdEnd:0.27, fallEnd:0.36 },
    { key:"wildlife", img:"assets/showcase-wildlife.jpg", kicker:"Wild places", title:"Your world, in metal.",
      riseStart:0.36, riseEnd:0.45, holdEnd:0.58, fallEnd:0.67 },
    { key:"anime", img:"assets/showcase-anime.jpg", kicker:"Your own", title:"Your image. Your VANTA.",
      riseStart:0.67, riseEnd:0.76, holdEnd:1.0, fallEnd:null }
  ];

  function clamp01(v){ return Math.min(1, Math.max(0, v)); }

  /* ---------- overlay alignment: replicate object-fit:cover's crop math ---------- */
  function positionOverlay(){
    var vw = stage.clientWidth, vh = stage.clientHeight;
    var scale = Math.max(vw/1920, vh/1080);
    var rw = 1920*scale, rh = 1080*scale;
    var offsetX = (vw-rw)/2, offsetY = (vh-rh)/2;
    reveal.style.left = (offsetX + PANEL_BOX.left*rw) + "px";
    reveal.style.top = (offsetY + PANEL_BOX.top*rh) + "px";
    reveal.style.width = (PANEL_BOX.width*rw) + "px";
    reveal.style.height = (PANEL_BOX.height*rh) + "px";
  }

  /* ---------- draw the current video frame to a canvas instead of trusting the
     video element's own on-screen compositing, which some GPU/driver combos fail
     to repaint reliably when the video is only ever seeked, never played ---------- */
  var canvasCssW = 0, canvasCssH = 0;
  function sizeCanvas(){
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasCssW = stage.clientWidth;
    canvasCssH = stage.clientHeight;
    canvas.width = Math.round(canvasCssW * dpr);
    canvas.height = Math.round(canvasCssH * dpr);
  }
  function drawFrame(){
    if (!video.videoWidth) return;
    var cw = canvas.width, ch = canvas.height;
    var scale = Math.max(cw/1920, ch/1080);
    var dw = 1920*scale, dh = 1080*scale;
    var dx = (cw-dw)/2, dy = (ch-dh)/2;
    try { ctx.drawImage(video, dx, dy, dw, dh); } catch(e){}
  }

  /* ---------- video time + caption mapping from scroll progress ---------- */
  function videoTimeForProgress(p, duration){
    var first = CYCLES[0];
    if (p <= first.riseStart) return 0;
    for (var i=0;i<CYCLES.length;i++){
      var c = CYCLES[i];
      if (p <= c.riseEnd){
        var t = (p - c.riseStart) / (c.riseEnd - c.riseStart);
        return duration * clamp01(t);
      }
      if (c.fallEnd === null || p <= c.holdEnd) return duration;
      if (p <= c.fallEnd){
        var tf = (p - c.holdEnd) / (c.fallEnd - c.holdEnd);
        return duration * (1 - clamp01(tf));
      }
    }
    return duration;
  }

  function cycleOpacity(c, p){
    var riseSpan = c.riseEnd - c.riseStart;
    var fadeInStart = c.riseEnd - riseSpan*0.4;
    if (p < fadeInStart) return 0;
    if (p < c.riseEnd) return clamp01((p - fadeInStart) / (riseSpan*0.4));
    if (c.fallEnd === null) return 1;
    if (p <= c.holdEnd) return 1;
    var fallSpan = c.fallEnd - c.holdEnd;
    var fadeOutEnd = c.holdEnd + fallSpan*0.4;
    if (p < fadeOutEnd) return clamp01(1 - (p - c.holdEnd) / (fallSpan*0.4));
    return 0;
  }

  var introEnd = CYCLES[0].riseStart;
  var settleStart = 0.9;

  var lastState = { cycle:-1, opacity:-1, band:"", kicker:"", title:"", introK:-1, settleK:-1 };

  function updateCaptions(p, loadK){
    /* intro: settles on load, then only reversible via scroll (band-one rule) */
    var introTarget = p < introEnd ? clamp01(1 - p/introEnd) : 0;
    var introK = Math.max(introTarget, p < 0.02 ? loadK : 0);
    if (Math.abs(introK - lastState.introK) > 0.004){
      introEl.style.setProperty("--kc", introK);
      introEl.style.opacity = introK > 0.01 ? 1 : 0;
      lastState.introK = introK;
    }

    var best = null, bestOp = 0, bestIdx = -1;
    for (var i=0;i<CYCLES.length;i++){
      var op = cycleOpacity(CYCLES[i], p);
      if (op > bestOp){ bestOp = op; best = CYCLES[i]; bestIdx = i; }
    }

    for (i=0;i<revealImgs.length;i++){
      var img = revealImgs[i];
      var op2 = cycleOpacity(CYCLES[i], p);
      if (Math.abs(op2 - (parseFloat(img.dataset.op)||0)) > 0.004){
        img.style.opacity = op2;
        img.dataset.op = op2;
        img.classList.toggle("active", op2 > 0.01);
      }
    }

    var showBand = best && bestOp > 0.02 && p < settleStart;
    if (showBand){
      if (lastState.band !== best.key){
        bandKicker.textContent = best.kicker;
        bandTitle.textContent = best.title;
        lastState.band = best.key;
      }
      if (Math.abs(bestOp - lastState.opacity) > 0.004){
        band.style.opacity = bestOp;
        band.style.setProperty("--kc", bestOp);
        lastState.opacity = bestOp;
      }
    } else if (lastState.opacity !== 0){
      band.style.opacity = 0;
      lastState.opacity = 0;
    }

    var settleK = p > settleStart ? clamp01((p - settleStart) / (1 - settleStart)) : 0;
    if (Math.abs(settleK - lastState.settleK) > 0.004){
      settleEl.style.opacity = settleK;
      settleEl.style.setProperty("--kc", settleK);
      lastState.settleK = settleK;
    }
    if (cueEl){
      var cueOp = p < 0.04 ? 1 : 0;
      if (cueEl.dataset.op !== String(cueOp)){
        cueEl.style.opacity = cueOp;
        cueEl.dataset.op = cueOp;
      }
    }
  }

  /* ---------- gated seeks: never write currentTime while a seek is in flight ---------- */
  var seekBusy = false, pendingTime = null, seekWatchdog = null;
  function requestSeek(t){
    if (!video.duration) return;
    /* a same-value seek never fires "seeked", which would otherwise deadlock the gate */
    if (Math.abs(video.currentTime - t) < 0.008) return;
    if (seekBusy){ pendingTime = t; return; }
    seekBusy = true;
    clearTimeout(seekWatchdog);
    seekWatchdog = setTimeout(function(){ seekBusy = false; }, 400);
    try { video.currentTime = t; } catch(e){ seekBusy = false; }
  }
  video.addEventListener("seeked", function(){
    seekBusy = false;
    clearTimeout(seekWatchdog);
    drawFrame();
    if (pendingTime !== null){
      var t = pendingTime; pendingTime = null;
      requestSeek(t);
    }
  });
  video.addEventListener("error", function(){ seekBusy = false; pendingTime = null; clearTimeout(seekWatchdog); });

  /* ---------- rAF lerp toward scroll target, rests when converged ---------- */
  var target = 0, shown = 0, rafId = null, lastTick = 0, heroOnScreen = true, loadK = 0, loadStart = 0;

  function heroProgress(){
    var rect = pin.getBoundingClientRect();
    var total = pin.offsetHeight - stage.clientHeight;
    if (total <= 0) return 0;
    return clamp01(-rect.top / total);
  }

  function tick(now){
    var dt = Math.min(100, now - (lastTick || now));
    lastTick = now;
    if (loadStart){
      loadK = clamp01((now - loadStart) / 900);
    }
    var k = 0.18;
    shown += (target - shown) * (1 - Math.pow(1 - k, dt/16.667));
    var converged = Math.abs(target - shown) < 0.0008 && loadK >= 1;
    if (converged){
      shown = target;
      rafId = null;
      lastTick = 0;
    } else {
      rafId = requestAnimationFrame(tick);
    }
    if (video.duration){
      requestSeek(videoTimeForProgress(shown, video.duration));
    }
    drawFrame();
    updateCaptions(shown, loadK);
  }

  function onScroll(){
    target = heroProgress();
    if (rafId === null && heroOnScreen) rafId = requestAnimationFrame(tick);
  }

  if ("IntersectionObserver" in window){
    new IntersectionObserver(function(entries){
      heroOnScreen = entries[0].isIntersecting;
      if (heroOnScreen && rafId === null) rafId = requestAnimationFrame(tick);
    }).observe(pin);
  }

  /* ---------- Blob load (small clip: plain fetch is fine) ---------- */
  var started = false;
  function startLoad(){
    if (started) return;
    started = true;
    loadStart = performance.now();
    fetch(VIDEO_URL).then(function(res){ return res.blob(); }).then(function(blob){
      video.src = URL.createObjectURL(blob);
      video.load();
      video.addEventListener("loadeddata", function(){
        sizeCanvas();
        var t = videoTimeForProgress(heroProgress(), video.duration || 6);
        video.currentTime = t;
        seekBusy = true;
        clearTimeout(seekWatchdog);
        seekWatchdog = setTimeout(function(){ seekBusy = false; }, 400);
        video.addEventListener("seeked", function once(){
          video.removeEventListener("seeked", once);
          drawFrame();
          stage.classList.add("video-ready");
        });
      }, { once:true });
    }).catch(failVideo);
  }
  function failVideo(){
    stage.classList.add("video-failed");
  }

  var posterImg = new Image();
  posterImg.onload = startLoad;
  posterImg.onerror = startLoad;
  posterImg.src = "assets/hero-poster.jpg";
  posterLayer.style.backgroundImage = "url('assets/hero-poster.jpg')";
  setTimeout(startLoad, 4000);
  video.addEventListener("error", failVideo);

  /* ---------- static-hero gates: live in both directions ---------- */
  var GATES = [
    "(max-width: 720px)",
    "(orientation: portrait) and (max-width: 1024px)",
    "(orientation: portrait) and (pointer: coarse)",
    "(orientation: landscape) and (pointer: coarse) and (max-height: 560px)",
    "(prefers-reduced-motion: reduce)"
  ];
  var scrubOn = false;
  function enableScrub(){
    if (scrubOn) return;
    scrubOn = true;
    if (!loadStart) loadStart = performance.now();
    positionOverlay();
    sizeCanvas();
    drawFrame();
    addEventListener("scroll", onScroll, { passive:true });
    addEventListener("resize", onResize);
    onScroll();
  }
  function onResize(){
    positionOverlay();
    sizeCanvas();
    drawFrame();
  }
  function disableScrub(){
    if (!scrubOn) return;
    scrubOn = false;
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onResize);
    if (rafId !== null){ cancelAnimationFrame(rafId); rafId = null; }
  }
  function applyHeroMode(){
    var gated = GATES.some(function(q){ return matchMedia(q).matches; });
    if (gated) disableScrub(); else enableScrub();
  }
  var mqls = GATES.map(function(q){ return matchMedia(q); });
  mqls.forEach(function(m){ m.addEventListener("change", applyHeroMode); });
  applyHeroMode();
})();
