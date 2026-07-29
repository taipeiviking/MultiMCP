// Import Signal Desktop's message history into the connector's store.
//
// Signal keeps no server-side history, so the only place years of messages
// exist on this machine is Signal Desktop's encrypted local database. The
// bundled sigtop (github.com/tbvdm/sigtop, ISC) decrypts it AS THE SAME
// WINDOWS USER (DPAPI-protected key) and exports per-conversation text files,
// which we parse and merge into the same messages.jsonl the live collector
// and the MCP servers use. One click back-fills the store.
//
// Text format, not JSON: newer Signal Desktop moved body/type/sent_at out of
// the raw JSON blob (sigtop's -f json dumps that blob → hollow records, seen
// live), while -f text is reconstructed from the real columns:
//
//   Conversation: Name (+66123... | Base64GroupId)
//
//   From: Alice Example (+66123456789)
//   Type: incoming
//   Sent: Thu, 3 Apr 2025 16:27:02 +0800
//   Received: Thu, 3 Apr 2025 22:27:53 +0800
//
//   body lines…
//
// Blocks separated by blank lines; group ids are filename-sanitized base64
// ('+'→'-', '/'→'_', padding dropped) and are restored so imported records
// match live-captured ones.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const credentials = require("./credentials");
const signal = require("./signal");
const log = require("./logger");

// Live-captured message timestamps have millisecond precision; the text export
// rounds to whole seconds. Treat same sender+text within this window as the
// same message so an import never duplicates what the collector already has.
const FUZZY_MS = 2000;

function sigtopPath() {
  const candidates = [];
  try {
    const { app } = require("electron");
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "sigtop", "sigtop.exe"));
    }
  } catch {
    /* not in electron */
  }
  candidates.push(path.join(__dirname, "..", "..", "vendor", "sigtop", "sigtop.exe"));
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function desktopDataDir() {
  const p = path.join(process.env.APPDATA || "", "Signal");
  return fs.existsSync(path.join(p, "config.json")) ? p : null;
}

function desktopRunning() {
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq Signal.exe", "/NH"], (err, stdout) => {
      resolve(!err && /Signal\.exe/i.test(stdout || ""));
    });
  });
}

// "Name (+886…)" -> { name, number } ; "Name (Base64Id)" -> { name, groupId }
function parseParenTarget(headerValue) {
  const m = headerValue.match(/^(.*)\s\(([^()]+)\)\s*$/);
  if (!m) return { name: headerValue.trim() };
  const token = m[2];
  if (token.startsWith("+")) return { name: m[1].trim(), number: token };
  if (/^[A-Za-z0-9_-]{40,}$/.test(token)) {
    let id = token.replace(/-/g, "+").replace(/_/g, "/");
    while (id.length % 4) id += "=";
    return { name: m[1].trim(), groupId: id };
  }
  return { name: headerValue.trim() };
}

const HEADER_RE = /^(From|Type|Sent|Received|Attachment|Quote|Reaction|Edited|Deleted|Sticker|Mention|Story|Call): /;

function parseConversationText(content, ownNumber) {
  const records = [];
  const convoLine = content.match(/^Conversation: (.+)$/m);
  const convo = convoLine ? parseParenTarget(convoLine[1]) : {};
  const blocks = content.split(/\r?\n\r?\n(?=(?:From|Type): )/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const headers = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const hm = lines[i].match(HEADER_RE);
      if (!hm) break;
      const key = hm[1];
      const val = lines[i].slice(key.length + 2);
      if (key === "Attachment") (headers.Attachments = headers.Attachments || []).push(val);
      else if (!(key in headers)) headers[key] = val;
    }
    if (headers.Type !== "incoming" && headers.Type !== "outgoing") continue;
    while (i < lines.length && lines[i].trim() === "") i++;
    const text = lines.slice(i).join("\n").trim() || null;
    const attachments = (headers.Attachments || []).map((a) => ({ filename: a }));
    if (!text && attachments.length === 0) continue;
    const ts = Date.parse(headers.Sent || "");
    if (!Number.isFinite(ts)) continue;
    const from = headers.From ? parseParenTarget(headers.From) : {};
    const outgoing = headers.Type === "outgoing";
    records.push({
      timestamp: ts,
      direction: outgoing ? "out" : "in",
      source: outgoing ? ownNumber : from.number || null,
      sourceName: outgoing ? null : from.name || null,
      recipient: outgoing && convo.number ? convo.number : null,
      groupId: convo.groupId || null,
      text,
      attachments,
      imported: true,
    });
  }
  return records;
}

function loadExistingKeys(storePath) {
  const exact = new Set();
  const fuzzy = new Map(); // "source|text" -> [timestamps]
  try {
    for (const line of fs.readFileSync(storePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      exact.add(`${rec.timestamp}|${rec.source}|${rec.text}`);
      const fk = `${rec.source}|${rec.text}`;
      if (!fuzzy.has(fk)) fuzzy.set(fk, []);
      fuzzy.get(fk).push(rec.timestamp);
    }
  } catch {
    /* empty store */
  }
  return { exact, fuzzy };
}

async function importFromDesktop() {
  const sigtop = sigtopPath();
  if (!sigtop) return { ok: false, error: "The import engine (sigtop) is not bundled in this build." };
  if (!desktopDataDir()) {
    return { ok: false, error: "Signal Desktop is not installed for this user — nothing to import." };
  }
  if (await desktopRunning()) {
    // Its database is locked while it runs; refusing beats killing the user's app.
    return { ok: false, error: "Please close Signal Desktop first (its database is locked while it runs), then try again." };
  }
  const settings = credentials.readSettings();
  const ownNumber = settings.signalAccount || null;

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "multimcp-sigimport-"));
  try {
    await new Promise((resolve, reject) => {
      execFile(sigtop, ["export-messages", "-f", "text", outDir], { windowsHide: true, maxBuffer: 16e6 }, (err, _o, stderr) =>
        err ? reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop())) : resolve()
      );
    });

    const storePath = path.join(signal.dataDir(), "multimcp", "messages.jsonl");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const { exact, fuzzy } = loadExistingKeys(storePath);

    let imported = 0;
    let skipped = 0;
    let conversations = 0;
    const outLines = [];
    for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith(".txt"))) {
      const recs = parseConversationText(fs.readFileSync(path.join(outDir, f), "utf8"), ownNumber);
      if (recs.length) conversations++;
      for (const rec of recs) {
        const key = `${rec.timestamp}|${rec.source}|${rec.text}`;
        if (exact.has(key)) {
          skipped++;
          continue;
        }
        const near = (fuzzy.get(`${rec.source}|${rec.text}`) || []).some(
          (t) => Math.abs(t - rec.timestamp) <= FUZZY_MS
        );
        if (near) {
          skipped++;
          continue;
        }
        exact.add(key);
        outLines.push(JSON.stringify(rec));
        imported++;
      }
    }
    if (outLines.length) fs.appendFileSync(storePath, outLines.join("\n") + "\n");
    log.info("signalImport", "Desktop history imported", { imported, skipped, conversations });
    return { ok: true, imported, skipped, conversations };
  } catch (e) {
    log.error("signalImport", "import failed", { message: String(e) });
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

module.exports = { importFromDesktop, parseConversationText, desktopDataDir };
