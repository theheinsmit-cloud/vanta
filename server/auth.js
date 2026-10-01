const crypto = require("crypto");
const { db, now } = require("./db");
const cfg = require("./config");
const { esc } = require("./lib/util");
const { hashPassword, verifyPassword } = require("./lib/password");

const COOKIE = "vanta_admin";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeEqual = (a, b) => {
  const x = sha256(String(a)), y = sha256(String(b));
  return crypto.timingSafeEqual(x, y);
};

/* ---------- passwords (scrypt) ---------- */
// A throwaway hash so a wrong username takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));

const isConfigured = () => !!(cfg.ADMIN_USERNAME && cfg.ADMIN_PASSWORD_HASH);

/* ---------- login throttling ---------- */
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 5, WINDOW_MS = 15 * 60 * 1000;
function throttle(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < Date.now()) return 0;
  return rec.count >= MAX_ATTEMPTS ? Math.ceil((rec.resetAt - Date.now()) / 60000) : 0;
}
function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else rec.count++;
}

/* ---------- sessions (server side, stored hashed) ---------- */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs(maxAgeSeconds) {
  return ["Path=/admin", "HttpOnly", "SameSite=Strict", "Max-Age=" + maxAgeSeconds, cfg.COOKIE_SECURE ? "Secure" : ""].filter(Boolean).join("; ");
}

function createSession(res, ip) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const ttl = cfg.SESSION_HOURS * 3600;
  db.prepare("INSERT INTO sessions (token_hash, csrf, created_at, expires_at, ip) VALUES (?,?,?,?,?)")
    .run(sha256hex(token), csrf, now(), new Date(Date.now() + ttl * 1000).toISOString(), ip || null);
  res.setHeader("Set-Cookie", COOKIE + "=" + token + "; " + cookieAttrs(ttl));
}

function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256hex(token));
  res.setHeader("Set-Cookie", COOKIE + "=; " + cookieAttrs(0));
}

function loadSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 200) return null;
  const hash = sha256hex(token);
  const s = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hash);
  if (!s) return null;
  if (s.expires_at < now()) { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash); return null; }
  return { hash, csrf: s.csrf, expiresAt: s.expires_at };
}

setInterval(() => { try { db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now()); } catch (e) { /* ignore */ } }, 3600 * 1000).unref();

/* ---------- middleware ---------- */
function attachSession(req, res, next) {
  req.session = isConfigured() ? loadSession(req) : null;
  next();
}

// Rejects cross-site form/fetch submissions in addition to the SameSite=Strict cookie.
function sameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch (e) { /* invalid */ }
    if (host !== req.headers.host) {
      console.warn("Blocked cross-site request: origin=" + origin + " host=" + req.headers.host + " " + req.method + " " + req.originalUrl);
      return res.status(403).json({ error: "Cross-site request blocked." });
    }
  }
  next();
}

function requireApi(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Please sign in again." });
  if (!["GET", "HEAD"].includes(req.method)) {
    const sent = req.headers["x-csrf-token"];
    if (!sent || !safeEqual(sent, req.session.csrf)) return res.status(403).json({ error: "Session check failed. Reload the page." });
  }
  next();
}

function requirePage(req, res, next) {
  if (!req.session) return res.redirect("/admin");
  next();
}

/* ---------- login page ---------- */
function loginPage({ error, configured }) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in — VANTA Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@600&family=Jost:wght@300;400;500&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{--canvas:#0b0a08;--panel:#17140f;--accent:#c9a24a;--accent-hover:#e3c074;--text:#f5f1e6;--muted:#a39c8c;--hairline:rgba(201,162,74,.28)}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--canvas);color:var(--text);font:300 16px/1.5 Jost,-apple-system,sans-serif;padding:20px}
  main{width:100%;max-width:380px;text-align:center}
  img{width:54px;height:54px;margin:0 auto 18px;display:block}
  h1{margin:0;font:600 30px/1 "Bodoni Moda",Georgia,serif;letter-spacing:.08em}
  .eyebrow{margin:8px 0 30px;font:400 11px/1 "Space Mono",monospace;letter-spacing:.24em;text-transform:uppercase;color:var(--accent)}
  form{background:var(--panel);border:1px solid var(--hairline);padding:28px 26px;text-align:left}
  label{display:block;font:400 11px/1 "Space Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  input{width:100%;background:#0b0a08;border:1px solid var(--hairline);color:var(--text);padding:13px 14px;font:400 16px Jost,sans-serif;margin-bottom:18px;border-radius:0}
  input:focus{outline:none;border-color:var(--accent)}
  button{width:100%;background:var(--accent);color:#0b0a08;border:0;padding:15px;font:700 12px "Space Mono",monospace;letter-spacing:.16em;text-transform:uppercase;cursor:pointer}
  button:hover{background:var(--accent-hover)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .err{border:1px solid rgba(214,120,100,.6);color:#e9a898;padding:11px 13px;margin-bottom:18px;font-size:14px}
</style></head>
<body><main>
  <img src="/assets/logo.png" alt="">
  <h1>VANTA</h1>
  <div class="eyebrow">Admin</div>
  <form method="post" action="/admin/login" autocomplete="on">
    ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
    ${configured ? "" : `<div class="err">Admin sign-in isn't set up yet. Run <code>npm run set-admin</code> on the server.</div>`}
    <label for="u">Username</label>
    <input id="u" name="username" type="text" autocomplete="username" required autofocus ${configured ? "" : "disabled"}>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required ${configured ? "" : "disabled"}>
    <button type="submit" ${configured ? "" : "disabled"}>Sign in</button>
  </form>
</main></body></html>`;
}

module.exports = {
  isConfigured, hashPassword, verifyPassword, safeEqual, throttle, recordFailure,
  createSession, destroySession, attachSession, sameOrigin, requireApi, requirePage, loginPage, DUMMY_HASH, attempts
};
