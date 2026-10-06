// iKhokha iK Pay API (https://developer.ikhokha.com/overview).
// Requests are signed: IK-SIGN = HMAC-SHA256(escape(path + body), AppSecret), hex.
// There is no sandbox: every payment link is live.
const crypto = require("crypto");
const { getSetting } = require("../db");
const { HttpError } = require("./util");

// IKHOKHA_API_BASE only exists for local testing against a stand-in server.
const BASE = process.env.IKHOKHA_API_BASE || "https://api.ikhokha.com/public-api/v1/api";

// Keys come from the admin Settings page (stored only in the server's database),
// or from IKHOKHA_APP_ID / IKHOKHA_APP_SECRET environment variables, which win if set.
function credentials() {
  const appId = (process.env.IKHOKHA_APP_ID || getSetting("ikhokha_app_id") || "").trim();
  const secret = (process.env.IKHOKHA_APP_SECRET || getSetting("ikhokha_app_secret") || "").trim();
  return appId && secret ? { appId, secret } : null;
}
const isConfigured = () => !!credentials();

// iKhokha's reference implementation escapes backslashes, quotes and NULs before signing.
function sign(path, body, secret) {
  const payload = (path + (body || "")).replace(/[\\"']/g, "\\$&").replace(/\u0000/g, "\\0");
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

async function call(method, endpoint, bodyObj) {
  const creds = credentials();
  if (!creds) throw new HttpError(503, "Online payments aren't set up yet.");
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const res = await fetch(BASE + endpoint, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", "IK-APPID": creds.appId, "IK-SIGN": sign(new URL(BASE + endpoint).pathname, body, creds.secret) },
    body: bodyObj ? body : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) {
    console.error("iKhokha " + method + " " + endpoint + " failed: " + res.status + " " + text.slice(0, 300));
    throw new HttpError(502, "The payment provider didn't accept the request.");
  }
  return data;
}

// Creates a payment link; amount in cents. Returns { paylinkID, paylinkUrl }.
async function createPaylink({ amountCents, externalTransactionID, description, requesterUrl, urls }) {
  const data = await call("POST", "/payment", {
    entityID: credentials().appId,
    amount: amountCents,
    currency: "ZAR",
    requesterUrl,
    mode: "live",
    description: String(description || "").slice(0, 100),
    externalTransactionID,
    urls
  });
  if (!data || data.responseCode !== "00" || !data.paylinkUrl || !data.paylinkID) {
    console.error("iKhokha create payment link unexpected response: " + JSON.stringify(data).slice(0, 300));
    throw new HttpError(502, "The payment provider didn't return a payment link.");
  }
  return { paylinkID: data.paylinkID, paylinkUrl: data.paylinkUrl };
}

// The authoritative answer: { paylinkID, status ("PAID" when paid), amount (cents), ... }.
async function getStatus(paylinkID) {
  return call("GET", "/getStatus/" + encodeURIComponent(paylinkID));
}

// Checks a webhook's ik-sign header. iKhokha signs callback path + JSON body; we try the raw
// body and a re-serialised copy, since their samples differ. Callers still confirm with getStatus.
function verifyWebhook(callbackPath, rawBody, parsedBody, header) {
  const creds = credentials();
  if (!creds || !header) return false;
  const given = Buffer.from(String(header).trim().toLowerCase());
  return [rawBody, JSON.stringify(parsedBody)].filter(Boolean).some((b) => {
    const expected = Buffer.from(sign(callbackPath, b, creds.secret));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

module.exports = { isConfigured, credentials, sign, createPaylink, getStatus, verifyWebhook };
