const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch (e) { /* no .env yet: admin login stays disabled */ }

const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RECEIPT_DIR = path.join(DATA_DIR, "receipts");
[DATA_DIR, UPLOAD_DIR, RECEIPT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const isProd = process.env.NODE_ENV === "production";

module.exports = {
  ROOT,
  SITE_DIR: path.join(ROOT, "site"),
  ADMIN_DIR: path.join(__dirname, "admin"),
  DATA_DIR,
  UPLOAD_DIR,
  RECEIPT_DIR,
  PORT: parseInt(process.env.PORT, 10) || 8080,
  isProd,
  // Public address used in payment links (where customers return and iKhokha sends notifications).
  PUBLIC_URL: (process.env.PUBLIC_URL || (isProd ? "https://vantastudios.co.za" : "")).replace(/\/$/, ""),
  // Admin credentials live only in server-side environment variables (.env).
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "",
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || "",
  // Cookies are Secure automatically in production, or when COOKIE_SECURE=true (e.g. behind HTTPS).
  COOKIE_SECURE: isProd || process.env.COOKIE_SECURE === "true",
  SESSION_HOURS: 8,
  TIMEZONE: "Africa/Johannesburg"
};
