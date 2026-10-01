/* VANTA pricing rules, the single source of truth for every price shown or charged.
   Loaded by the Create page and the admin Pricing page (display) and required by the
   server (authoritative: every order is recalculated there). All money is in cents,
   so totals are exact to two decimals with no rounding drift.

   Model: every A4 panel costs the same (pricePerPanelCents). A handling charge
   (handlingCents) is added once per order and is advertised to customers as free
   delivery. Volume discounts are a percentage off the panel subtotal only, never off
   handling, chosen by the total number of physical panels in the order. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VantaPricing = factory();
})(this, function () {
  "use strict";

  function sortTiers(tiers) {
    return (tiers || []).slice().sort(function (a, b) { return a.minPanels - b.minPanels; });
  }

  // Validates tiers from the admin form or settings: [{ minPanels, pct }]. Throws a readable Error.
  function cleanTiers(raw) {
    if (!Array.isArray(raw)) throw new Error("Volume discounts are invalid.");
    var seen = {};
    var out = raw.map(function (t) {
      var minPanels = Number(t && t.minPanels), pct = Math.round(Number(t && t.pct) * 100) / 100;
      if (!(minPanels >= 2 && minPanels <= 1000 && Math.floor(minPanels) === minPanels)) throw new Error("Each discount needs a whole number of panels of 2 or more.");
      if (!(pct > 0 && pct < 100)) throw new Error("Each discount must be more than 0% and less than 100%.");
      if (seen[minPanels]) throw new Error("Two discounts start at " + minPanels + " panels.");
      seen[minPanels] = true;
      return { minPanels: minPanels, pct: pct };
    });
    return sortTiers(out);
  }

  // A time-limited special price per panel, e.g. { name, pricePerPanelCents, endsAt (ISO) }.
  // Active until endsAt; after that every page falls back to the regular price by itself.
  function activePromo(cfg, nowMs) {
    var p = cfg && cfg.promo;
    if (!p || !(p.pricePerPanelCents > 0) || p.pricePerPanelCents >= cfg.pricePerPanelCents) return null;
    var now = nowMs == null ? Date.now() : nowMs;
    var ends = Date.parse(p.endsAt);
    return isFinite(ends) && now < ends ? p : null;
  }

  // panels = total physical panels in the order (every copy of every print counts).
  // nowMs decides whether the special applies (defaults to now).
  function quote(panels, cfg, nowMs) {
    panels = Math.max(0, Math.floor(Number(panels) || 0));
    var promo = activePromo(cfg, nowMs);
    var regularCents = cfg.pricePerPanelCents;
    cfg = { pricePerPanelCents: promo ? promo.pricePerPanelCents : regularCents, handlingCents: cfg.handlingCents, tiers: cfg.tiers };
    var tiers = sortTiers(cfg.tiers);
    var applied = null, next = null;
    tiers.forEach(function (t) {
      if (panels >= t.minPanels) applied = t;
      else if (!next) next = t;
    });
    var pct = applied ? applied.pct : 0;
    var baseCents = panels * cfg.pricePerPanelCents;
    var discountCents = Math.round(baseCents * pct / 100);
    var handlingCents = panels > 0 ? cfg.handlingCents : 0;
    // What customers see: every panel advertised at the REGULAR price + handling (e.g. R350 + R100 = R450).
    // Handling is only charged once, so panels 2..n show it back as a "multi-panel discount",
    // and a running special shows as its own saving per panel.
    var advertisedPerPanelCents = regularCents + cfg.handlingCents;
    return {
      panels: panels,
      pricePerPanelCents: cfg.pricePerPanelCents,   // the price actually charged per panel
      regularPricePerPanelCents: regularCents,
      promo: promo ? { name: promo.name, pricePerPanelCents: promo.pricePerPanelCents, endsAt: promo.endsAt } : null,
      promoSavingCents: promo ? panels * (regularCents - promo.pricePerPanelCents) : 0,
      baseCents: baseCents,                       // panels x price, before discount
      handlingCents: handlingCents,               // once per order, never discounted
      listCents: baseCents + handlingCents,       // panels x price + handling, before volume discount
      advertisedPerPanelCents: advertisedPerPanelCents,
      advertisedCents: panels * advertisedPerPanelCents,
      multiPanelSavingCents: panels > 1 ? (panels - 1) * cfg.handlingCents : 0,
      discountPct: pct,
      discountFromPanels: applied ? applied.minPanels : null,
      discountCents: discountCents,
      discountedBaseCents: baseCents - discountCents,
      totalCents: baseCents - discountCents + handlingCents,
      nextTier: next ? { minPanels: next.minPanels, pct: next.pct, panelsNeeded: next.minPanels - panels } : null
    };
  }

  // "31 December": the last day a special runs, in South African time.
  function promoLastDay(promo) {
    return new Date(Date.parse(promo.endsAt) - 1).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "long" });
  }

  return { quote: quote, cleanTiers: cleanTiers, activePromo: activePromo, promoLastDay: promoLastDay };
});
