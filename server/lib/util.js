const path = require("path");
const { TIMEZONE } = require("../config");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

// "1234.5" -> 123450. Returns null if it isn't a usable number.
function toCents(v) {
  if (v === null || v === undefined || v === "") return null;
  let s = String(v).trim().replace(/\s/g, "");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  s = s.replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const rand = (cents) => Math.round(cents) / 100;

const clampStr = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function safeFilename(name, fallback = "file") {
  const base = path.basename(String(name || fallback)).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return base || fallback;
}

// YYYY-MM-DD in South African time.
const saDate = (d = new Date()) => new Date(d).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
const isDateStr = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

module.exports = { esc, toCents, rand, clampStr, slug, safeFilename, saDate, isDateStr, HttpError };
