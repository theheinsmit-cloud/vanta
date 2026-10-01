// Usage: node scripts/set-admin.js <username> [password]
// Writes ADMIN_USERNAME and a scrypt ADMIN_PASSWORD_HASH to .env. With no password given, a strong one
// is generated and printed once. The plain password is never stored.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashPassword } = require("../server/lib/password");

const username = process.argv[2];
let password = process.argv[3];
if (!username || !/^[\w.@-]{3,64}$/.test(username)) {
  console.error("Usage: node scripts/set-admin.js <username> [password]\nUsername: 3-64 letters, numbers or . _ @ -");
  process.exit(1);
}
let generated = false;
if (!password) { password = crypto.randomBytes(15).toString("base64url"); generated = true; }
if (password.length < 12) { console.error("Password must be at least 12 characters."); process.exit(1); }

const envPath = path.join(__dirname, "..", ".env");
let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/).filter(Boolean) : [];
lines = lines.filter((l) => !/^ADMIN_(USERNAME|PASSWORD_HASH)=/.test(l));
lines.push("ADMIN_USERNAME=" + username, "ADMIN_PASSWORD_HASH=" + hashPassword(password));
fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });

console.log("Admin account saved to .env (username: " + username + ").");
if (generated) console.log("Generated password (shown once, save it now): " + password);
console.log("Restart the server for the change to take effect.");
