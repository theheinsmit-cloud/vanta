const express = require("express");
const cfg = require("./config");
require("./db");
const auth = require("./auth");

const app = express();
app.disable("x-powered-by");

// Public API (pricing + order submission).
app.use("/api", require("./routes/public"));

// Private admin. Never linked from the public site, never cached, never indexed.
app.use("/admin", (req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
  });
  next();
}, auth.attachSession, auth.sameOrigin, require("./routes/admin"));

app.use(express.static(cfg.SITE_DIR, {
  index: "index.html",
  dotfiles: "ignore",
  setHeaders: (res) => { if (!cfg.isProd) res.set("Cache-Control", "no-store"); }
}));

app.use((req, res) => res.status(404).type("text").send("Not found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).type("text").send("Server error");
});

app.listen(cfg.PORT, "0.0.0.0", () => {
  console.log("VANTA running on http://localhost:" + cfg.PORT);
  if (!auth.isConfigured()) console.log("Admin login is disabled. Run: npm run set-admin");
});

// Unpaid checkouts are removed after a week (on start, then every 6 hours).
const { cleanupCheckouts } = require("./lib/orders");
const sweep = () => { try { cleanupCheckouts(); } catch (e) { console.error("Checkout cleanup failed:", e); } };
sweep();
setInterval(sweep, 6 * 3600 * 1000).unref();
