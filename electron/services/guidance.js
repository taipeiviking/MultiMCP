// Agent-guidance service.
//
// A connector isn't enough on its own: an AI client that also has a built-in,
// single-account Gmail/Drive/Calendar integration will happily reach for THAT and
// never touch MultiMCP - or use it for only the one account it was set up with. The
// fix is standing guidance telling the agent to use only MultiMCP and to always
// specify which of the several connected accounts to act on.
//
// Each client has more than one place this can live, and - as we learned the hard
// way with Codex - the per-session rules file alone doesn't always stick. So we
// target both the rules file AND the durable memory the client keeps:
//
//   OpenAI Codex:
//     - ~/.codex/AGENTS.md                              (per-session rules)
//     - ~/.codex/memories/extensions/ad_hoc/notes/*.md  (durable memory; its
//       instructions.md declares notes here "authoritative" and consolidates them,
//       which is what makes a fresh session actually comply)
//   Claude:
//     - ~/.claude/CLAUDE.md   (Claude Code memory file - a real file we can diff)
//     - Claude Desktop has no rules file, so we can only hand over text to paste
//       into its Settings (a "copy" target).
//
// We wrap what we add in sentinel markers so we can find our own block again to
// update it (e.g. when the account list changes) and never duplicate it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const accounts = require("./accounts");
const log = require("./logger");

const BEGIN = "<!-- MultiMCP:begin (managed by Google Workspace Manager) -->";
const END = "<!-- MultiMCP:end -->";
const MEMORY_SLUG = "multimcp-only-google-services";

function accountEmails() {
  try {
    return accounts.listAccounts().map((a) => a.email).filter(Boolean);
  } catch {
    return [];
  }
}

// The rules, tailored per client (tool naming differs). Deliberately emphatic:
// "always and only", plus the account-specific point that was the original bug.
function guidanceBullets(client) {
  const emails = accountEmails();
  const list = emails.length
    ? emails.join(", ")
    : "the accounts added in Google Workspace Manager";
  const tools =
    client === "codex"
      ? "the `mcp__MultiMCP__*` tools"
      : "the **MultiMCP** connector's tools";
  return [
    `- In every session, for every task touching **Gmail, Google Calendar, or Google Drive**, use **only** ${tools} (the user's MultiMCP server). This overrides any default or recommendation.`,
    "- **Never** use a built-in, app, plugin, or skill-suggested Gmail/Calendar/Drive integration — even if one is available or recommended — and never fall back to another connector.",
    `- **Several Google accounts are connected** through MultiMCP, so never assume one. Always pass the specific account (the \`user_google_email\` argument) with every request. Connected accounts: ${list}.`,
    "- If a required MultiMCP capability is unavailable, **stop and tell the user** instead of using anything else.",
  ];
}

function guidanceBody(client) {
  return ["## Google Workspace — always use MultiMCP, and always name the account", "", ...guidanceBullets(client)].join("\n");
}

// Content for a Codex durable-memory note (its own file; a `#` title reads better
// than an `##` there).
function memoryNoteText() {
  return [
    BEGIN,
    "# Durable preference — Google Workspace via MultiMCP only",
    "",
    ...guidanceBullets("codex"),
    END,
    "",
  ].join("\n");
}

function block(client) {
  return `${BEGIN}\n${guidanceBody(client)}\n${END}\n`;
}

function markedBlock(text) {
  if (!text) return null;
  const s = text.indexOf(BEGIN);
  if (s < 0) return null;
  const e = text.indexOf(END, s);
  if (e < 0) return null;
  return text.slice(s, e + END.length);
}

// Is guidance already present? Two ways: our marker, or a heuristic that recognises
// the user's OWN equivalent rules (so we never duplicate a hand-written AGENTS.md).
function detect(text) {
  if (!text) return { present: false, method: null };
  if (text.includes(BEGIN)) return { present: true, method: "marker" };
  const mentionsMultiMcp = /MultiMCP/i.test(text);
  const mentionsGoogle = /gmail|calendar|drive/i.test(text);
  const isRestrictive =
    /\bonly\b|never use|do not use|don't use|instead of|user_google_email|mcp__MultiMCP__/i.test(text);
  if (mentionsMultiMcp && mentionsGoogle && isRestrictive) {
    return { present: true, method: "heuristic" };
  }
  return { present: false, method: null };
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}
function codexAgentsPath() {
  return path.join(codexHome(), "AGENTS.md");
}
function codexMemoryNotesDir() {
  return path.join(codexHome(), "memories", "extensions", "ad_hoc", "notes");
}
// Codex's ad-hoc memory extension exists only once Codex has initialised its memory
// store. We only offer the memory target when it does - dropping a note into a
// non-existent store wouldn't be picked up.
function codexMemoryAvailable() {
  return fs.existsSync(path.join(codexHome(), "memories", "extensions", "ad_hoc"));
}
// The existing note for our topic, if any (Codex names them <stamp>-<slug>.md). We
// reuse/overwrite it rather than pile up new ones.
function findCodexMemoryNote() {
  try {
    const f = fs
      .readdirSync(codexMemoryNotesDir())
      .find((n) => n.endsWith(`-${MEMORY_SLUG}.md`) || n === `${MEMORY_SLUG}.md`);
    return f ? path.join(codexMemoryNotesDir(), f) : null;
  } catch {
    return null;
  }
}
function claudeMdPath() {
  return path.join(os.homedir(), ".claude", "CLAUDE.md");
}

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readText(p) {
  try {
    return { text: fs.readFileSync(p, "utf8"), exists: true };
  } catch {
    return { text: "", exists: false };
  }
}

// The targets for a client. `kind: "file"` is writable (diff + apply); `kind: "copy"`
// is text the user pastes where we can't write (Claude Desktop).
function targetsFor(client) {
  if (client === "codex") {
    const list = [
      { key: "agents", label: "~/.codex/AGENTS.md", sub: "Codex reads this as standing rules each session", kind: "file", path: codexAgentsPath() },
    ];
    if (codexMemoryAvailable()) {
      list.push({
        key: "memory",
        label: "~/.codex/memories/…/notes",
        sub: "Codex durable memory — what makes a fresh session actually comply",
        kind: "codexNote",
        path: findCodexMemoryNote(),
      });
    }
    return list;
  }
  if (client === "claude") {
    return [
      { key: "claudemd", label: "~/.claude/CLAUDE.md", sub: "Claude Code memory (used when you drive Claude via Claude Code)", kind: "file", path: claudeMdPath() },
      { key: "desktop", label: "Claude Desktop → Settings → custom instructions", sub: "Claude Desktop has no rules file — paste this in instead", kind: "copy" },
    ];
  }
  return [];
}

function statusForTarget(client, t) {
  if (t.kind === "copy") {
    return { ...t, present: null, text: guidanceBody(client) };
  }
  if (t.kind === "codexNote") {
    const p = t.path; // existing note path or null
    const { text } = p ? readText(p) : { text: "" };
    const det = detect(text);
    return { ...t, exists: !!p, present: det.present, method: det.method, proposed: memoryNoteText().trimEnd(), current: markedBlock(text) };
  }
  // plain file target
  const { text, exists } = readText(t.path);
  const det = detect(text);
  return { ...t, exists, present: det.present, method: det.method, proposed: block(client).trimEnd(), current: markedBlock(text) };
}

function getStatus(client) {
  const targets = targetsFor(client).map((t) => statusForTarget(client, t));
  // "done" reflects the writable targets only (we can't detect the copy paste).
  const writable = targets.filter((t) => t.kind === "file" || t.kind === "codexNote");
  const done = writable.length > 0 && writable.every((t) => t.present);
  return { client, targets, done };
}

function writeAtomic(p, text) {
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

function upsertBlockIntoFile(p, blk) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const { text } = readText(p);
  let next;
  const existing = markedBlock(text);
  if (existing) next = text.replace(existing, blk.trimEnd());
  else if (text.trim()) next = text.replace(/\s*$/, "") + "\n\n" + blk;
  else next = blk;
  if (next === text) return { ok: true, path: p, unchanged: true };
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-${Date.now()}`);
  writeAtomic(p, next);
  return { ok: true, path: p };
}

// Add (or update) our guidance in a writable target. Never called for "copy".
function apply(client, targetKey) {
  const t = targetsFor(client).find((x) => x.key === targetKey);
  if (!t) return { ok: false, error: `unknown target: ${targetKey}` };
  try {
    if (t.kind === "codexNote") {
      const dir = codexMemoryNotesDir();
      fs.mkdirSync(dir, { recursive: true });
      // Reuse an existing note for this topic; otherwise create one with Codex's
      // <stamp>-<slug>.md convention. The whole note is ours, so replace it wholesale.
      const p = findCodexMemoryNote() || path.join(dir, `${tsStamp()}-${MEMORY_SLUG}.md`);
      const text = memoryNoteText();
      const cur = readText(p).text;
      if (cur === text) return { ok: true, path: p, unchanged: true };
      if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-${Date.now()}`);
      writeAtomic(p, text);
      log.info("guidance", "wrote Codex memory note", { path: p });
      return { ok: true, path: p };
    }
    if (t.kind === "file") {
      const r = upsertBlockIntoFile(t.path, block(client));
      log.info("guidance", "wrote agent guidance", { client, path: t.path });
      return r;
    }
    return { ok: false, error: `not a writable target: ${targetKey}` };
  } catch (e) {
    log.error("guidance", "apply failed", { client, targetKey, message: String(e) });
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { getStatus, apply, guidanceBody };
