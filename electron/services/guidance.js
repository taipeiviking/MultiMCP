// Agent-guidance service.
//
// A connector isn't enough on its own: an AI client that also has a built-in,
// single-account Gmail/Drive/Calendar integration will happily reach for THAT and
// never touch MultiMCP - or use it for only the one account it was set up with. The
// fix is a short instruction the agent reads as standing guidance, telling it to use
// only MultiMCP and to always specify which of the several connected accounts to act
// on.
//
// Each client reads such guidance from a different place:
//   - OpenAI Codex   -> ~/.codex/AGENTS.md  (a real file; Codex reads it as rules)
//   - Claude Code    -> ~/.claude/CLAUDE.md (a real file; the memory/rules file)
//   - Claude Desktop -> no file at all; its custom instructions live in the app's
//                       settings UI, so for that we can only hand the user text to
//                       paste (a "copy" target, not a writable one).
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

function accountEmails() {
  try {
    return accounts.listAccounts().map((a) => a.email).filter(Boolean);
  } catch {
    return [];
  }
}

// The human-readable guidance, tailored per client (the tool naming differs).
function guidanceBody(client) {
  const emails = accountEmails();
  const list = emails.length
    ? emails.join(", ")
    : "the accounts you added in Google Workspace Manager";
  const tools =
    client === "codex"
      ? "the `mcp__MultiMCP__*` tools"
      : "the **MultiMCP** connector's tools";
  return [
    "## Google Workspace access — always use MultiMCP",
    "",
    `- For **Gmail, Google Calendar, and Google Drive**, use **only** ${tools} (from the user's MultiMCP server). Do **not** use any built-in, app-provided, or plugin Gmail/Calendar/Drive integration, and never fall back to a single default account.`,
    `- **Several Google accounts are connected through MultiMCP**, so never assume one. Always pass the specific account (the \`user_google_email\` argument) with every request. Connected accounts: ${list}.`,
    "- If a required MultiMCP capability is unavailable, stop and tell the user rather than switching to another integration.",
  ].join("\n");
}

function block(client) {
  return `${BEGIN}\n${guidanceBody(client)}\n${END}\n`;
}

// Pull out our marked block if it's present (for showing a replace-diff).
function markedBlock(text) {
  if (!text) return null;
  const s = text.indexOf(BEGIN);
  if (s < 0) return null;
  const e = text.indexOf(END, s);
  if (e < 0) return null;
  return text.slice(s, e + END.length);
}

// Is guidance already present? Two ways it can be:
//   marker    - we (or a previous run) wrote our block.
//   heuristic - the user wrote their own equivalent rules (like the AGENTS.md Codex
//               itself created). We must recognise that and NOT duplicate it.
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

function codexAgentsPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "AGENTS.md");
}

function claudeMdPath() {
  return path.join(os.homedir(), ".claude", "CLAUDE.md");
}

// The targets for a client. `kind: "file"` is writable (we can diff+apply);
// `kind: "copy"` is text the user pastes somewhere we can't write (Claude Desktop).
function targetsFor(client) {
  if (client === "codex") {
    return [{ key: "agents", label: "~/.codex/AGENTS.md", sub: "Codex reads this as standing rules", kind: "file", path: codexAgentsPath() }];
  }
  if (client === "claude") {
    return [
      { key: "claudemd", label: "~/.claude/CLAUDE.md", sub: "Claude Code memory (used when you drive Claude via Claude Code)", kind: "file", path: claudeMdPath() },
      { key: "desktop", label: "Claude Desktop → Settings → custom instructions", sub: "Claude Desktop has no rules file — paste this in instead", kind: "copy" },
    ];
  }
  return [];
}

function readText(p) {
  try {
    return { text: fs.readFileSync(p, "utf8"), exists: true };
  } catch {
    return { text: "", exists: false };
  }
}

function getStatus(client) {
  const targets = targetsFor(client).map((t) => {
    if (t.kind === "copy") {
      return { ...t, present: null, text: guidanceBody(client) };
    }
    const { text, exists } = readText(t.path);
    const det = detect(text);
    return {
      ...t,
      exists,
      present: det.present,
      method: det.method,
      proposed: block(client).trimEnd(),
      current: markedBlock(text),
    };
  });
  // The card's "done" reflects the writable targets only (we can't detect the
  // copy-only Desktop paste). Done when every writable target already has guidance.
  const fileTargets = targets.filter((t) => t.kind === "file");
  const done = fileTargets.length > 0 && fileTargets.every((t) => t.present);
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

// Add (or update) our block in a writable target. Replaces an existing marked block
// in place; otherwise appends. Backs up first. Never called for a "copy" target.
function apply(client, targetKey) {
  const t = targetsFor(client).find((x) => x.key === targetKey);
  if (!t || t.kind !== "file") return { ok: false, error: `not a writable target: ${targetKey}` };
  const p = t.path;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { text } = readText(p);
    const blk = block(client);

    let next;
    const existing = markedBlock(text);
    if (existing) {
      next = text.replace(existing, blk.trimEnd()); // update our block in place
    } else if (text.trim()) {
      next = text.replace(/\s*$/, "") + "\n\n" + blk; // append after existing content
    } else {
      next = blk; // fresh/empty file
    }

    if (next === text) return { ok: true, path: p, unchanged: true };
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-${Date.now()}`);
    writeAtomic(p, next);
    log.info("guidance", "wrote agent guidance", { client, path: p, updated: !!existing });
    return { ok: true, path: p };
  } catch (e) {
    log.error("guidance", "apply failed", { client, targetKey, message: String(e) });
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { getStatus, apply, guidanceBody };
