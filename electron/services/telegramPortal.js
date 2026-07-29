// Guided my.telegram.org setup: obtain the user's api_id/api_hash WITHOUT the
// copy-paste trip through a browser.
//
// The portal is plain form endpoints (no official API — this is best-effort
// scraping, with manual entry as the documented fallback in the UI):
//   POST /auth/send_password {phone}                -> {random_hash}; Telegram
//        messages the user a WEB LOGIN code in their app
//   POST /auth/login {phone, random_hash, password: <that code>}
//        -> "true" + stel_token cookie
//   GET  /apps                                       -> either the app page
//        (api_id + api_hash as uneditable inputs) or the creation form
//   POST /apps/create {hash, app_title, ...}         -> registers the app
//
// SECURITY NOTE: the portal session can manage the account's API access, so it
// is held ONLY in memory, used for this one flow, and dropped immediately —
// nothing about it is persisted. What we keep is exactly what the manual flow
// would have produced: api_id (settings) + api_hash (Credential Manager).

const credentials = require("./credentials");
const telegram = require("./telegram");
const log = require("./logger");

const fs = require("fs");
const path = require("path");
const telegramSvc = require("./telegram"); // for dataDir (debug dump location)

const BASE = "https://my.telegram.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// On a scrape miss, dump the full apps-page HTML next to the session so the
// exact structure can be diagnosed (it holds no secret beyond the credentials
// we were trying to read, and lives in the user's own locked data dir).
function dumpApps(html) {
  try {
    const p = path.join(telegramSvc.dataDir(), "apps-debug.html");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html);
    return p;
  } catch {
    return null;
  }
}

// In-memory flow state: {phone, randomHash, cookies}
let pending = null;

function collectCookies(res, jar = {}) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function post(path, form, jar) {
  const res = await fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      Referer: BASE + "/",
      ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  return { res, text };
}

async function get(path, jar) {
  const res = await fetch(BASE + path, {
    redirect: "manual",
    headers: { "User-Agent": UA, Cookie: cookieHeader(jar) },
  });
  return { res, text: await res.text() };
}

// Step 1: ask Telegram to message the user their web login code.
async function requestWebCode(phone) {
  pending = null;
  // Establish the base session cookie (stel_ssid) first — send_password/login
  // are bound to it, and without it the later stel_token session won't stick.
  const jar = {};
  const seed = await get("/auth", jar);
  collectCookies(seed.res, jar);

  const { res, text } = await post("/auth/send_password", { phone }, jar);
  collectCookies(res, jar);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Rate limits and refusals come back as plain text.
    throw new Error(text.trim().slice(0, 200) || `my.telegram.org answered HTTP ${res.status}`);
  }
  if (!body.random_hash) throw new Error("my.telegram.org did not issue a login (unexpected response).");
  pending = { phone, randomHash: body.random_hash, cookies: jar };
  log.info("telegramPortal", "web login code requested");
  return { codeSent: true };
}

// A real Telegram api_id is a small positive integer (fits a signed 32-bit int
// — Telethon serializes it with struct '<i'). This guard is the load-bearing
// safety net: if scraping ever grabs the wrong token (a phone number, a
// timestamp), validation fails and we throw → the UI falls back to manual
// entry, instead of saving garbage that only surfaces as a daemon crash later.
function validApiId(v, phone) {
  if (!/^\d{4,10}$/.test(v)) return false;
  if (Number(v) >= 2147483648) return false; // would overflow struct '<i'
  const phoneDigits = String(phone || "").replace(/\D/g, "");
  if (phoneDigits && (phoneDigits.includes(v) || v.includes(phoneDigits))) return false;
  return true;
}

const scrapeCreds = (html, phone) => {
  // Drop <head>/<script>/<style> and the CSRF form hash BEFORE extracting: the
  // head carries traps that look like credentials — notably
  // <meta ... content="app-id=686449807"> (Telegram's iOS App Store id, a
  // valid-looking 9-digit int) and a 32-hex CSRF token in the create form. Only
  // the body's labelled values are real.
  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/name="hash"\s+value="[0-9a-f]+"/gi, " ");

  // LAYOUT-INDEPENDENT: strip remaining tags to plain text, then read by label,
  // so the exact markup around each value does not matter.
  const text = body
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");

  // Both values are LABEL-ANCHORED ("App api_id: <n>", "App api_hash: <hex>").
  // That anchoring — not a blanket token scan — is what keeps head/CSRF noise
  // out. validApiId is the final backstop.
  const idLabelled = (text.match(/api_id[:\s]*(\d{4,10})/i) || [])[1];
  const ids = [];
  if (idLabelled) ids.push(idLabelled);
  for (const m of body.matchAll(/uneditable-input[^>]*>\s*(\d{4,10})\s*</gi)) ids.push(m[1]);
  const apiId = ids.find((c) => validApiId(c, phone)) || null;

  const apiHash =
    (text.match(/api_hash[:\s]*([0-9a-f]{32})/i) || [])[1] ||
    (body.match(/uneditable-input[^>]*>\s*([0-9a-f]{32})\s*</i) || [])[1] ||
    null;

  if (!apiId || !apiHash) return null;
  return { apiId, apiHash };
};

// Step 2: log in with the code, find-or-create the application, save the pair.
async function completeSetup(code) {
  if (!pending) throw new Error("Start over — the setup session expired.");
  const { phone, randomHash } = pending;
  const jar = pending.cookies;

  const login = await post("/auth/login", { phone, random_hash: randomHash, password: code }, jar);
  collectCookies(login.res, jar);
  // Login succeeds with body "true" and a stel_token cookie. A wrong/expired
  // code returns an error string with no token.
  if (!jar.stel_token && login.text.trim() !== "true") {
    throw new Error(login.text.trim().slice(0, 200) || "Login failed — wrong or expired code?");
  }

  let apps = await get("/apps", jar);
  // If /apps redirected us back to auth, the session cookie didn't take.
  if (apps.res.status >= 300 && apps.res.status < 400) {
    throw new Error("Could not establish a my.telegram.org session. Please use manual entry.");
  }
  let creds = scrapeCreds(apps.text, phone);

  if (!creds) {
    // No application registered yet — create one, then re-read.
    const formHash = apps.text.match(/name="hash"\s+value="([0-9a-f]+)"/);
    if (!formHash) {
      const dump = dumpApps(apps.text);
      log.warn("telegramPortal", "no app + no create form", { dump, len: apps.text.length });
      throw new Error("Could not read the application page — please use manual entry.");
    }
    const created = await post(
      "/apps/create",
      {
        hash: formHash[1],
        app_title: "MultiMCP",
        app_shortname: `multimcp${String(Date.now()).slice(-5)}`,
        app_url: "",
        app_platform: "desktop",
        app_desc: "",
      },
      jar
    );
    // The portal's infamous bare "ERROR" (anti-abuse) surfaces here.
    if (/error/i.test(created.text) && created.res.status < 300) {
      throw new Error(
        "Telegram's portal refused to create the application (it sometimes does this for a while). " +
          "Try again later, or use manual entry."
      );
    }
    apps = await get("/apps", jar);
    creds = scrapeCreds(apps.text, phone);
    if (!creds) {
      const dump = dumpApps(apps.text);
      log.warn("telegramPortal", "post-create scrape failed", { dump, len: apps.text.length });
      throw new Error("Set up the application, but couldn't read valid credentials back. Please use manual entry.");
    }
    log.info("telegramPortal", "application registered");
  }

  // Final guard: never persist an implausible api_id (this is what turned a bad
  // scrape into a daemon crash before). If it fails here, keep nothing.
  if (!validApiId(creds.apiId, phone)) {
    log.warn("telegramPortal", "scraped api_id failed validation", { got: creds.apiId });
    throw new Error("The credentials read from Telegram didn't look valid. Please use manual entry.");
  }

  pending = null; // drop the portal session immediately
  await telegram.saveApiCreds(creds.apiId, creds.apiHash);
  log.info("telegramPortal", "credentials captured", { apiIdLen: creds.apiId.length });
  return { ok: true };
}

function cancel() {
  pending = null;
  return { ok: true };
}

module.exports = { requestWebCode, completeSetup, cancel };
