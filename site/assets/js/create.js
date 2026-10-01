(function(){
  "use strict";

  var uploadZone = document.getElementById("upload-zone");
  var fileInput = document.getElementById("file-input");
  var previewWrap = document.querySelector(".preview-wrap");
  var cropFrame = document.getElementById("crop-frame");
  var gridOverlay = document.getElementById("grid-overlay");
  var previewImg = document.getElementById("preview-img");
  var zoomSlider = document.getElementById("zoom-slider");
  var resBadge = document.getElementById("res-badge");
  var resNote = document.getElementById("res-note");
  var changeImageBtn = document.getElementById("change-image");
  var lowResConfirm = document.getElementById("low-res-confirm");
  var lowResCheck = document.getElementById("low-res-check");
  var orderForm = document.getElementById("order-form");
  var orderSuccess = document.getElementById("order-success");
  var submitBtn = document.getElementById("submit-order");
  var printFilesEl = document.getElementById("print-files");
  var orderRefEl = document.getElementById("order-ref");
  var originalFile = null;   // the customer's untouched upload, sent to the server as-is
  var configurator = document.querySelector(".configurator");
  var layoutInputs = document.querySelectorAll('input[name="layout"]');
  var orientationInputs = document.querySelectorAll('input[name="orientation"]');
  var arrangementInputs = document.querySelectorAll('input[name="arrangement"]');
  var arrangementGroup = document.getElementById("arrangement-group");
  var panelCountEl = document.getElementById("panel-count");
  var addBtn = document.getElementById("add-to-order");
  var cartEl = document.getElementById("cart");
  var priceLinesEl = document.getElementById("price-lines");
  var uploadTitle = document.getElementById("upload-title");
  var uploadSub = document.getElementById("upload-sub");

  if (!uploadZone) return;

  var A4_W_MM = 210, A4_H_MM = 297;
  var LAYOUTS = {
    single:      { cols: 1, rows: 1 },
    duo:         { cols: 2, rows: 1 },
    duoStacked:  { cols: 1, rows: 2 },
    quad:        { cols: 2, rows: 2 }
  };
  var layoutKey = "single";
  var arrangement = "side"; // Duo only: "side" (2 across) or "stacked" (2 down)
  var layout = LAYOUTS.single;
  var orientation = "portrait"; // or "landscape" — rotates every panel, grid arrangement (cols/rows) stays

  var natural = { w: 0, h: 0 };
  var baseCoverScale = 1;     // CSS-px scale so the image covers the frame at zoom 1
  var zoom = 1;
  var pan = { x: 0, y: 0 };   // px offset at the current scale, clamped to bounds
  var imageOk = false;
  var lowRes = false;

  function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }
  /* Exact inner size of the crop frame. The frame's content box is the true
     print ratio (box-sizing:content-box), so height is derived from width
     rather than read from integer-rounded clientWidth/clientHeight. */
  function frameSize(){
    var w = parseFloat(getComputedStyle(cropFrame).width);
    var mm = compositeMm();
    return { w: w, h: w * mm.h / mm.w };
  }
  var PAN_EPS = 0.5; // px of overhang per side below which the image counts as fitting exactly
  function panelMm(){
    return orientation === "landscape" ? { w: A4_H_MM, h: A4_W_MM } : { w: A4_W_MM, h: A4_H_MM };
  }
  function compositeMm(){
    var p = panelMm();
    return { w: layout.cols * p.w, h: layout.rows * p.h };
  }

  /* ---------- layout (panel count) selection ---------- */
  function buildGridOverlay(){
    gridOverlay.innerHTML = "";
    gridOverlay.style.gridTemplateColumns = "repeat(" + layout.cols + ",1fr)";
    gridOverlay.style.gridTemplateRows = "repeat(" + layout.rows + ",1fr)";
    var total = layout.cols * layout.rows;
    for (var i = 0; i < total; i++){
      var cell = document.createElement("div");
      var col = i % layout.cols, row = Math.floor(i / layout.cols);
      var style = "";
      if (col < layout.cols - 1) style += "border-right:2px solid rgba(8,7,5,.85);";
      if (row < layout.rows - 1) style += "border-bottom:2px solid rgba(8,7,5,.85);";
      cell.setAttribute("style", style);
      gridOverlay.appendChild(cell);
    }
  }
  function resetOrder(){
    if (!orderSuccess.classList.contains("show")) return;
    orderSuccess.classList.remove("show");
    orderForm.hidden = false;
    printFilesEl.querySelectorAll("a").forEach(function(a){ URL.revokeObjectURL(a.href); });
    printFilesEl.innerHTML = "";
    orderRefEl.textContent = "";
  }
  function applyLayout(){
    resetOrder();
    var mm = compositeMm();
    var p = panelMm();
    cropFrame.style.aspectRatio = mm.w + " / " + mm.h;
    buildGridOverlay();
    var total = layout.cols * layout.rows;
    panelCountEl.textContent = total === 1
      ? "1 panel · A4, " + p.w + " × " + p.h + "mm"
      : total + " panels (" + p.w + " × " + p.h + "mm each) · " + mm.w + " × " + mm.h + "mm combined";
    if (imageOk){ layoutImage(); updateResolution(); }
    updatePrice();
  }
  function resolveLayout(){
    layout = (layoutKey === "duo" && arrangement === "stacked") ? LAYOUTS.duoStacked : LAYOUTS[layoutKey];
    arrangementGroup.hidden = layoutKey !== "duo";
  }
  layoutInputs.forEach(function(input){
    input.addEventListener("change", function(){
      if (input.checked) { layoutKey = input.value; resolveLayout(); applyLayout(); }
    });
  });
  arrangementInputs.forEach(function(input){
    input.addEventListener("change", function(){
      if (input.checked) { arrangement = input.value; resolveLayout(); applyLayout(); }
    });
  });
  orientationInputs.forEach(function(input){
    input.addEventListener("change", function(){
      if (input.checked) { orientation = input.value; applyLayout(); }
    });
  });

  /* ---------- upload ---------- */
  uploadZone.addEventListener("click", function(){ fileInput.click(); });
  uploadZone.addEventListener("dragover", function(e){ e.preventDefault(); uploadZone.classList.add("drag"); });
  uploadZone.addEventListener("dragleave", function(){ uploadZone.classList.remove("drag"); });
  uploadZone.addEventListener("drop", function(e){
    e.preventDefault();
    uploadZone.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", function(){
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  function handleFile(file){
    if (!/^image\/(jpeg|png)$/.test(file.type)){
      vantaDialog({ title:"Unsupported file", message:"Please upload a JPG or PNG file." });
      return;
    }
    resetOrder();
    originalFile = file;
    var reader = new FileReader();
    reader.onload = function(e){
      previewImg.onload = function(){
        natural.w = previewImg.naturalWidth;
        natural.h = previewImg.naturalHeight;
        imageOk = true;
        uploadZone.hidden = true;
        previewWrap.classList.add("active");
        zoom = 1;
        zoomSlider.value = 1;
        layoutImage();
        updateResolution();
        renderCart();
        configurator.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      previewImg.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // Back to the empty upload state (after "Use a different image", or once a print is added to the cart).
  function clearEditor(){
    uploadZone.hidden = false;
    previewWrap.classList.remove("active");
    imageOk = false;
    lowRes = false;
    originalFile = null;
    fileInput.value = "";
    lowResConfirm.classList.remove("show");
    lowResCheck.checked = false;
    renderCart();
  }
  changeImageBtn.addEventListener("click", function(){
    resetOrder();
    clearEditor();
  });

  /* ---------- crop: cover-fit base scale, user zoom, drag to pan ----------
     The frame represents the FULL combined canvas (all panels together), one
     continuous image spans it, the grid lines are a visual overlay only. */
  function layoutImage(){
    var f = frameSize();
    baseCoverScale = Math.max(f.w / natural.w, f.h / natural.h);
    pan.x = 0; pan.y = 0;
    applyTransform();
  }
  function applyTransform(){
    var s = baseCoverScale * zoom;
    previewImg.style.width = natural.w + "px";
    previewImg.style.height = natural.h + "px";
    previewImg.style.transform = "translate(calc(-50% + " + pan.x + "px), calc(-50% + " + pan.y + "px)) scale(" + s + ")";
  }
  function panBounds(){
    var f = frameSize();
    var s = baseCoverScale * zoom;
    var ox = (natural.w * s - f.w) / 2;
    var oy = (natural.h * s - f.h) / 2;
    return {
      x: ox > PAN_EPS ? ox : 0,
      y: oy > PAN_EPS ? oy : 0
    };
  }
  function clampPan(){
    var b = panBounds();
    pan.x = clamp(pan.x, -b.x, b.x);
    pan.y = clamp(pan.y, -b.y, b.y);
  }

  zoomSlider.addEventListener("input", function(){
    resetOrder();
    zoom = parseFloat(zoomSlider.value);
    clampPan();
    applyTransform();
    updateResolution();
  });

  var dragging = false, dragStart = null, panStart = null;
  cropFrame.addEventListener("pointerdown", function(e){
    if (!imageOk) return;
    dragging = true;
    cropFrame.classList.add("grabbing");
    cropFrame.setPointerCapture(e.pointerId);
    dragStart = { x: e.clientX, y: e.clientY };
    panStart = { x: pan.x, y: pan.y };
  });
  cropFrame.addEventListener("pointermove", function(e){
    if (!dragging) return;
    resetOrder();
    pan.x = panStart.x + (e.clientX - dragStart.x);
    pan.y = panStart.y + (e.clientY - dragStart.y);
    clampPan();
    applyTransform();
  });
  function endDrag(){ dragging = false; cropFrame.classList.remove("grabbing"); }
  cropFrame.addEventListener("pointerup", endDrag);
  cropFrame.addEventListener("pointercancel", endDrag);

  addEventListener("resize", function(){ if (imageOk) { layoutImage(); updateResolution(); } });

  /* ---------- resolution estimate ----------
     Effective print DPI from the source pixels actually covering the FULL
     combined canvas at the current zoom, not just the raw file dimensions.
     More panels need more source resolution for the same sharpness. */
  function updateResolution(){
    if (!imageOk) return;
    var mm = compositeMm();
    var imgAspect = natural.w / natural.h;
    var canvasAspect = mm.w / mm.h;
    var baseDpi = imgAspect > canvasAspect
      ? natural.h / (mm.h / 25.4)
      : natural.w / (mm.w / 25.4);
    var dpi = Math.round(baseDpi / zoom);

    lowRes = dpi < 100;
    var marginal = dpi >= 100 && dpi < 180;
    var sizeLabel = (layout.cols * layout.rows) === 1 ? "at A4" : "across all panels";

    resBadge.classList.remove("good", "ok", "bad");
    if (dpi >= 180){
      resBadge.classList.add("good");
      resBadge.innerHTML = '<span class="dot"></span> Sharp ' + sizeLabel + ' (~' + dpi + ' DPI)';
      resNote.textContent = "Your image has plenty of resolution for a crisp, full-bleed print" + (layout.cols*layout.rows>1 ? " across every panel." : ".");
    } else if (marginal){
      resBadge.classList.add("ok");
      resBadge.innerHTML = '<span class="dot"></span> Usable, slightly soft (~' + dpi + ' DPI)';
      resNote.textContent = "This will print fine but won't be razor sharp up close. Zooming out (less crop), a smaller layout, or a higher-res source file will help.";
    } else {
      resBadge.classList.add("bad");
      resBadge.innerHTML = '<span class="dot"></span> Below recommended (~' + dpi + ' DPI)';
      resNote.textContent = "This image is likely to look soft or blurry printed this large. Try a higher-resolution source, a smaller layout, or less zoom.";
    }
    lowResConfirm.classList.toggle("show", lowRes);
    if (!lowRes) lowResCheck.checked = false;
  }

  /* ---------- cart: one order can hold several prints, each with its own image, layout, crop and copies ----------
     Prices are defaults until the server answers; the server recalculates every order anyway. */
  var PRICES = { single: 449, duo: 449, quad: 449 }; // price per panel, per layout (sliding scale)
  var DELIVERY = 0;
  var MAX_ITEMS = 10, MAX_QTY = 20;
  fetch("/api/pricing", { cache: "no-store" }).then(function(r){ return r.ok ? r.json() : null; }).then(function(p){
    if (p && p.prices){
      PRICES = p.prices; DELIVERY = p.shipping;
      if (p.maxItems) MAX_ITEMS = p.maxItems;
      if (p.maxQty) MAX_QTY = p.maxQty;
      renderCart();
    }
  }).catch(function(){ /* keep the defaults if the server can't be reached */ });

  var LAYOUT_NAME = { single: "Single", duo: "Duo", quad: "Quad" };
  var cart = [];      // { layoutKey, arrangement, orientation, panels, qty, dpi, lowResConfirmed, original, files, thumb }
  function rands(n){ return "R" + Number(n).toLocaleString("en-US", { maximumFractionDigits:2 }); }
  function describe(it){
    return LAYOUT_NAME[it.layoutKey] + " · " + (it.orientation === "landscape" ? "Landscape" : "Portrait") +
      (it.layoutKey === "duo" ? ", " + (it.arrangement === "stacked" ? "stacked" : "side by side") : "");
  }
  function lineTotal(it){ return PRICES[it.layoutKey] * it.panels * it.qty; }
  // The print on screen right now counts towards the total and is added automatically when the order is placed.
  function draftItem(){
    return imageOk ? { layoutKey: layoutKey, arrangement: arrangement, orientation: orientation, panels: layout.cols * layout.rows, qty: 1, thumb: previewImg.src, draft: true } : null;
  }
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function cartRow(it, no){
    var row = el("div", "cart-item" + (it.draft ? " pending" : ""));
    var img = el("img", "cart-thumb"); img.src = it.thumb; img.alt = "";
    var info = el("div");
    info.appendChild(el("div", "cart-title", "Print " + no + " · " + describe(it)));
    info.appendChild(el("div", "cart-sub", it.panels + " panel" + (it.panels > 1 ? "s" : "") + " · " + rands(PRICES[it.layoutKey]) + " per panel"));
    row.appendChild(img); row.appendChild(info);
    row.appendChild(el("div", "cart-price", rands(lineTotal(it))));
    var actions = el("div", "cart-actions");
    if (it.draft){
      actions.appendChild(el("span", "cart-tag", "On screen now · included when you order"));
    } else {
      var qty = el("div", "qty"); qty.setAttribute("role", "group"); qty.setAttribute("aria-label", "Copies of print " + no);
      var minus = el("button", null, "−"); minus.type = "button"; minus.setAttribute("aria-label", "One copy fewer"); minus.disabled = it.qty <= 1;
      var out = el("output", null, String(it.qty)); out.setAttribute("aria-live", "polite");
      var plus = el("button", null, "+"); plus.type = "button"; plus.setAttribute("aria-label", "One copy more"); plus.disabled = it.qty >= MAX_QTY;
      minus.addEventListener("click", function(){ if (it.qty > 1){ it.qty--; renderCart(); } });
      plus.addEventListener("click", function(){ if (it.qty < MAX_QTY){ it.qty++; renderCart(); } });
      qty.appendChild(minus); qty.appendChild(out); qty.appendChild(plus);
      var remove = el("button", "cart-remove", "Remove"); remove.type = "button";
      remove.addEventListener("click", function(){
        vantaDialog({ title: "Remove print", message: "Remove print " + no + " (" + describe(it) + ") from your order?", ok: "Remove", cancel: "Keep it" }).then(function(yes){
          if (!yes) return;
          it.files.forEach(function(f){ URL.revokeObjectURL(f.url); });
          cart.splice(cart.indexOf(it), 1);
          renderCart();
        });
      });
      actions.appendChild(qty); actions.appendChild(remove);
    }
    row.appendChild(actions);
    return row;
  }
  function priceRow(label, value){
    var row = el("div", "price-row");
    row.appendChild(el("span", "label", label));
    row.appendChild(el("span", null, value));
    return row;
  }
  function renderCart(){
    var draft = draftItem();
    var all = draft ? cart.concat([draft]) : cart.slice();

    cartEl.innerHTML = "";
    if (!all.length) cartEl.appendChild(el("p", "cart-empty", "No prints yet. Upload an image to start your order."));
    all.forEach(function(it, i){ cartEl.appendChild(cartRow(it, i + 1)); });

    priceLinesEl.innerHTML = "";
    var subtotal = 0;
    all.forEach(function(it, i){
      var count = it.panels * it.qty, line = lineTotal(it);
      subtotal += line;
      var label = all.length > 1 ? "Print " + (i + 1) + " · " + LAYOUT_NAME[it.layoutKey] + (it.qty > 1 ? " × " + it.qty : "") : "VANTA A4 metal print" + (it.qty > 1 ? " × " + it.qty : "");
      priceLinesEl.appendChild(priceRow(label, (count > 1 ? count + " × " + rands(PRICES[it.layoutKey]) + " = " : "") + rands(line)));
    });
    if (!all.length) priceLinesEl.appendChild(priceRow("VANTA A4 metal print", rands(0)));
    var deliveryEl = document.getElementById("price-delivery");
    deliveryEl.textContent = DELIVERY > 0 ? rands(DELIVERY) : "Free";
    deliveryEl.classList.toggle("free", !(DELIVERY > 0));
    document.getElementById("price-total").textContent = rands(subtotal + (all.length ? DELIVERY : 0));

    var full = cart.length >= MAX_ITEMS;
    addBtn.disabled = !imageOk || full;
    addBtn.textContent = full ? "Order is full (" + MAX_ITEMS + " prints)" : "Add to order";
    uploadTitle.textContent = cart.length ? "Add another print" : "Drag and drop your image";
    uploadSub.textContent = cart.length ? "Drop your next image here, or click to browse. JPG or PNG." : "or click to browse. JPG or PNG.";
  }
  function updatePrice(){ renderCart(); }

  // Turns the print on screen into a cart item (with its print files). Resolves true when added.
  function addCurrentToCart(){
    if (!imageOk) return Promise.resolve(false);
    if (cart.length >= MAX_ITEMS){
      vantaDialog({ title: "Order is full", message: "One order can hold up to " + MAX_ITEMS + " different prints. Place this order, then start a new one." });
      return Promise.resolve(false);
    }
    if (lowRes && !lowResCheck.checked){
      vantaDialog({ title: "Lower print quality", message: "Please confirm you're okay with the lower print quality, or upload a higher-resolution image." });
      return Promise.resolve(false);
    }
    addBtn.disabled = true;
    addBtn.textContent = "Preparing print files…";
    return generatePrintFiles().then(function(result){
      cart.push({
        layoutKey: layoutKey, arrangement: arrangement, orientation: orientation, panels: layout.cols * layout.rows, qty: 1,
        dpi: result.dpi, lowResConfirmed: lowRes && lowResCheck.checked, original: originalFile, files: result.files, thumb: result.thumb
      });
      clearEditor();
      return true;
    }, function(err){ renderCart(); throw err; });
  }
  addBtn.addEventListener("click", function(){
    addCurrentToCart().then(function(added){
      if (added) uploadZone.scrollIntoView({ behavior: "smooth", block: "center" });
    }).catch(function(){
      vantaDialog({ title: "Couldn't add this print", message: "Something went wrong preparing your print files. Please try again." });
    });
  });

  /* ---------- generate the actual print-ready files ----------
     Renders the full composite at the same DPI the resolution badge already
     promised (capped at 300, never upscaled past what the source supports),
     using the exact pan/zoom/crop the customer confirmed, then slices that
     ONE continuous render into per-panel tiles. Slicing a single canvas
     (rather than re-cropping the source per panel) is what guarantees the
     seams align pixel-for-pixel with no gaps or drift between panels. */
  function panelLabel(row, col){
    var total = layout.cols * layout.rows;
    if (total === 1) return "Full print";
    var vert = layout.rows > 1 ? (row === 0 ? "Top" : "Bottom") : "";
    var horiz = layout.cols > 1 ? (col === 0 ? "Left" : "Right") : "";
    return [vert, horiz].filter(Boolean).join(" ");
  }

  function generatePrintFiles(){
    return new Promise(function(resolve){
      var mm = compositeMm();
      var imgAspect = natural.w / natural.h;
      var canvasAspect = mm.w / mm.h;
      var baseDpi = imgAspect > canvasAspect
        ? natural.h / (mm.h / 25.4)
        : natural.w / (mm.w / 25.4);
      var achievedDpi = baseDpi / zoom;
      var outputDpi = Math.min(300, achievedDpi);

      var outW = Math.max(1, Math.round(mm.w / 25.4 * outputDpi));
      var outH = Math.max(1, Math.round(mm.h / 25.4 * outputDpi));

      var f = frameSize(), fw = f.w, fh = f.h;
      var k = outW / fw; // scale factor: preview CSS px -> output px

      var s = baseCoverScale * zoom;
      var imageLeft = fw / 2 + pan.x - (natural.w * s) / 2;
      var imageTop  = fh / 2 + pan.y - (natural.h * s) / 2;

      var bigCanvas = document.createElement("canvas");
      bigCanvas.width = outW;
      bigCanvas.height = outH;
      var ctx = bigCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(previewImg,
        imageLeft * k, imageTop * k,
        natural.w * s * k, natural.h * s * k);

      // Small preview of exactly what will print, for the cart.
      var tScale = 160 / Math.max(outW, outH);
      var thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = Math.max(1, Math.round(outW * tScale));
      thumbCanvas.height = Math.max(1, Math.round(outH * tScale));
      thumbCanvas.getContext("2d").drawImage(bigCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      var thumb = thumbCanvas.toDataURL("image/jpeg", 0.8);

      var cols = layout.cols, rows = layout.rows;
      var panelPxW = Math.round(outW / cols);
      var panelPxH = Math.round(outH / rows);
      var files = [];
      var pending = cols * rows;

      for (var row = 0; row < rows; row++){
        for (var col = 0; col < cols; col++){
          (function(row, col){
            var panelCanvas = document.createElement("canvas");
            panelCanvas.width = panelPxW;
            panelCanvas.height = panelPxH;
            panelCanvas.getContext("2d").drawImage(
              bigCanvas, col * panelPxW, row * panelPxH, panelPxW, panelPxH,
              0, 0, panelPxW, panelPxH
            );
            panelCanvas.toBlob(function(blob){
              files.push({
                row: row, col: col,
                label: panelLabel(row, col),
                blob: blob,
                url: URL.createObjectURL(blob),
                name: "vanta-" + (cols * rows) + "panel-r" + (row + 1) + "c" + (col + 1) + ".jpg",
                w: panelPxW, h: panelPxH
              });
              pending--;
              if (pending === 0){
                files.sort(function(a, b){ return (a.row - b.row) || (a.col - b.col); });
                resolve({ files: files, dpi: Math.round(outputDpi), thumb: thumb });
              }
            }, "image/jpeg", 0.95);
          })(row, col);
        }
      }
    });
  }

  function renderDownloadLinks(items){
    printFilesEl.innerHTML = "";
    printFilesEl.style.display = "block";
    items.forEach(function(it, i){
      var group = el("div", "print-group");
      group.appendChild(el("h4", null, (items.length > 1 ? "Print " + (i + 1) + " · " : "") + describe(it) + (it.qty > 1 ? " × " + it.qty : "")));
      var grid = el("div", "print-files");
      it.files.forEach(function(f){
        var a = document.createElement("a");
        a.href = f.url;
        a.download = items.length > 1 ? f.name.replace(/^vanta-/, "vanta-print" + (i + 1) + "-") : f.name;
        a.className = "print-file-link";
        a.innerHTML =
          '<span class="pf-label">' + (f.label || "Print") + '</span>' +
          '<span class="pf-meta">' + f.w + ' × ' + f.h + 'px · ~' + it.dpi + ' DPI</span>' +
          '<span class="pf-dl">Download<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4v12M6 12l6 6 6-6"/><path d="M4 20h16"/></svg></span>';
        grid.appendChild(a);
      });
      group.appendChild(grid);
      printFilesEl.appendChild(group);
    });
  }

  /* ---------- send the order to the server: for every print, the untouched original plus each panel file ---------- */
  function sendOrder(items){
    var els = orderForm.elements;
    var f = new FormData();
    ["firstName", "lastName", "email", "phone", "address", "city", "postal"].forEach(function(n){ f.set(n, els[n].value); });
    f.set("rights", els.rights.checked ? "true" : "false");
    f.set("items", JSON.stringify(items.map(function(it){
      return {
        layout: it.layoutKey, orientation: it.orientation, arrangement: it.layoutKey === "duo" ? it.arrangement : null,
        qty: it.qty, dpi: it.dpi, lowResConfirmed: it.lowResConfirmed,
        panels: it.files.map(function(x, i){ return { index: i + 1, label: x.label }; })
      };
    })));
    items.forEach(function(it, i){
      var no = i + 1;
      f.set("original-" + no, it.original, it.original.name);
      it.files.forEach(function(x){ f.append("panel-" + no, x.blob, x.name); });
    });
    return fetch("/api/orders", { method: "POST", body: f }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok) throw new Error(data.error || "We couldn't save your order. Please try again.");
        return data;
      });
    });
  }

  /* ---------- submit: payment gateway not yet connected, the order is captured and sent to our queue ---------- */
  orderForm.addEventListener("submit", function(e){
    e.preventDefault();
    if (!cart.length && !imageOk){
      vantaDialog({ title:"No image yet", message:"Please upload an image first." });
      return;
    }
    if (imageOk && lowRes && !lowResCheck.checked){
      vantaDialog({ title:"Lower print quality", message:"Please confirm you're okay with the lower print quality, or upload a higher-resolution image." });
      return;
    }
    submitBtn.disabled = true;
    var originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Preparing your print files…";

    // The print still on screen is part of the order: add it first.
    (imageOk ? addCurrentToCart() : Promise.resolve(true)).then(function(ok){
      if (!ok) return null;
      submitBtn.textContent = "Sending your order…";
      return sendOrder(cart).then(function(order){
        renderDownloadLinks(cart);
        orderRefEl.textContent = "Order reference: " + order.orderNumber;
        orderForm.hidden = true;
        orderSuccess.classList.add("show");
        orderSuccess.scrollIntoView({ behavior: "smooth", block: "start" });
        cart = [];   // the success screen keeps its own links; the next upload starts a fresh order
        renderCart();
      });
    }).catch(function(err){
      vantaDialog({ title:"Order not sent", message: err && err.message ? err.message : "We couldn't save your order. Please try again." });
    }).then(function(){
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    });
  });

  applyLayout();
})();
