// Adversarial tests for tomlEdit.js.  Run:  node electron/services/tomlEdit.test.js
//
// Every case here is legal TOML that breaks the naive regex/line-based
// implementation. If you are tempted to "simplify" tomlEdit.js, run this first.

const TOML = require("smol-toml");
const {
  upsertTable,
  removeTable,
  validateEdit,
  parseOrNull,
  tomlString,
  TomlRefusal,
  BOM,
} = require("./tomlEdit");

const PATH = ["mcp_servers", "MultiMCP"];
const SENTINELS = {
  begin: "# >>> MultiMCP (managed by Google Workspace Manager) - regenerated on write, do not edit",
  end: "# <<< MultiMCP",
};

// A realistic entry, including the two values most likely to break escaping.
const SCALARS = {
  command: "C:\\Users\\class\\AppData\\Local\\Programs\\MultiMCP\\resources\\uv\\uvx.exe",
  args: ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
  startup_timeout_sec: 60,
};
const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_MCP_CREDENTIALS_DIR: "C:\\Users\\class\\.google_workspace_mcp\\credentials",
  MCP_SINGLE_USER_MODE: "1",
  WORKSPACE_MCP_PORT: "9001",
  BROWSER: "C:\\Users\\class\\AppData\\Local\\MultiMCP\\no-browser.cmd",
};
const EXPECTED = Object.assign({}, SCALARS, { env: ENV });

const write = (raw) =>
  upsertTable(raw, { path: PATH, scalars: SCALARS, subTables: { env: ENV }, sentinels: SENTINELS });

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n          ${e.message.split("\n").join("\n          ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
// The full contract: parses, our table is exact, nothing else moved.
function assertValid(before, after) {
  const old = parseOrNull(before) || {};
  const problems = validateEdit(old, after, PATH, EXPECTED);
  assert(problems.length === 0, `validateEdit: ${problems.join("; ")}`);
}
// Preservation: every non-blank line of the original must still be present.
function assertPreserved(before, after, { except = [] } = {}) {
  for (const line of before.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || except.some((e) => t.includes(e))) continue;
    assert(after.includes(line.trim()), `LOST LINE: ${JSON.stringify(line)}`);
  }
}

console.log("\n=== escaping ===");
check("windows path uses a LITERAL string (no double-backslash bug)", () => {
  assert(tomlString("C:\\Users\\x\\uvx.exe") === "'C:\\Users\\x\\uvx.exe'", tomlString("C:\\Users\\x\\uvx.exe"));
  assert(TOML.parse(`p = ${tomlString("C:\\Users\\x\\uvx.exe")}`).p === "C:\\Users\\x\\uvx.exe", "roundtrip");
});
check("apostrophe forces a BASIC string and still round-trips", () => {
  const v = "it's a \\ backslash \"quote\"";
  const out = tomlString(v);
  assert(out.startsWith('"'), `expected basic string, got ${out}`);
  assert(TOML.parse(`p = ${out}`).p === v, "roundtrip failed");
});
check("value with newline + control char round-trips", () => {
  const v = "a\nb\tcd";
  assert(TOML.parse(`p = ${tomlString(v)}`).p === v, "roundtrip failed");
});

console.log("\n=== fresh file ===");
check("empty file -> valid config", () => {
  const out = write("").text;
  assertValid("", out);
});

console.log("\n=== preservation ===");
const RICH = `# My Codex config. Hands off!
model = "o3"
approval_policy = "on-request"

# ---- my own servers ----
[mcp_servers.github]
command = "npx"           # inline comment
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.github.env]
GITHUB_TOKEN = "ghp_xxx"

[tui]
theme = "dark"
`;
check("rich config: comments, model, other servers all survive", () => {
  const out = write(RICH).text;
  assertValid(RICH, out);
  assertPreserved(RICH, out);
  assert(out.includes("# My Codex config. Hands off!"), "header comment lost");
  assert(out.includes("# ---- my own servers ----"), "section comment lost");
  assert(out.includes('command = "npx"           # inline comment'), "inline comment lost");
});
check("idempotent: writing twice yields identical bytes", () => {
  const a = write(RICH).text;
  const b = write(a).text;
  assert(a === b, "second write differed (block or blank lines accumulating)");
  assertValid(RICH, b);
});
check("a comment above the NEXT table is not eaten", () => {
  const src = `[mcp_servers.MultiMCP]
command = "old"

# notes about my TUI settings
[tui]
theme = "dark"
`;
  const out = write(src).text;
  assert(out.includes("# notes about my TUI settings"), "ate the next table's comment");
  assertValid(src, out);
});

console.log("\n=== the four shapes of an existing entry (all must be REPLACED) ===");
const STALE = "STALE_KEY_MUST_NOT_SURVIVE";
check("A. std table + SEPARATE env header elsewhere in the file", () => {
  const src = `[mcp_servers.MultiMCP]
command = "old"
args = ["nope"]

[tui]
theme = "dark"

[mcp_servers.MultiMCP.env]
${STALE} = "1"
GOOGLE_OAUTH_CLIENT_ID = "old"
`;
  const out = write(src).text;
  assertValid(src, out);
  assert(!out.includes(STALE), "stale env key survived the rewrite");
  assert(out.includes("[tui]"), "lost [tui]");
});
check("B. root dotted inline table  mcp_servers.MultiMCP = {...}", () => {
  const src = `model = "o3"
mcp_servers.MultiMCP = { command = "old", env = { ${STALE} = "1" } }

[tui]
theme = "dark"
`;
  const out = write(src).text;
  assertValid(src, out);
  assert(!out.includes(STALE), "stale env key survived");
});
check("C. key inside [mcp_servers]:  MultiMCP = {...}", () => {
  const src = `[mcp_servers]
MultiMCP = { command = "old", env = { ${STALE} = "1" } }
other = { command = "keepme" }
`;
  const out = write(src).text;
  assertValid(src, out);
  assert(!out.includes(STALE), "stale env key survived");
  assert(out.includes('other = { command = "keepme" }'), "clobbered a sibling server");
});
check("D. dotted keys inside [mcp_servers]:  MultiMCP.command = ...", () => {
  const src = `[mcp_servers]
MultiMCP.command = "old"
MultiMCP.env.${STALE} = "1"
other.command = "keepme"
`;
  const out = write(src).text;
  assertValid(src, out);
  assert(!out.includes(STALE), "stale env key survived");
  assert(out.includes('other.command = "keepme"'), "clobbered a sibling server");
});
check("E. exotic spellings of the same table are found and replaced", () => {
  const src = `[ mcp_servers . "MultiMCP" ]
command = "old"
${STALE} = "1"
`;
  const out = write(src).text;
  assertValid(src, out);
  assert(!out.includes(STALE), "stale key survived: exotic header spelling was not matched");
});

console.log("\n=== the traps that break a regex implementation ===");
check("multi-line string containing a FAKE header is untouched", () => {
  const src = `[prompts]
tpl = """
Here is an example config:
[mcp_servers.MultiMCP]
command = "not real, this is documentation"
"""

[tui]
theme = "dark"
`;
  const out = write(src).text;
  assertValid(src, out);
  // The string's contents must survive verbatim.
  const back = TOML.parse(out);
  assert(back.prompts.tpl.includes('[mcp_servers.MultiMCP]'), "cut a hole through a string literal");
  assert(back.prompts.tpl.includes('not real, this is documentation'), "string body damaged");
});
check("multi-line array with '[' at column 0 is not mistaken for a header", () => {
  const src = `[grid]
cells = [
[1, 2],
[3, 4],
]
after = true
`;
  const out = write(src).text;
  assertValid(src, out);
  assert(TOML.parse(out).grid.after === true, "array mis-sliced");
});

console.log("\n=== encoding ===");
check("CRLF file stays CRLF", () => {
  const src = "model = \"o3\"\r\n\r\n[tui]\r\ntheme = \"dark\"\r\n";
  const r = write(src);
  assertValid(src, r.text);
  assert(r.eol === "\r\n", "did not detect CRLF");
  const added = r.text.slice(src.length);
  assert(!/[^\r]\n/.test(added), "emitted LF into a CRLF file");
});
check("BOM is preserved (and does not break validation)", () => {
  const src = BOM + 'model = "o3"\n';
  const r = write(src);
  assert(r.text.startsWith(BOM), "BOM lost");
  assertValid(src, r.text);
});
check("file with no trailing newline", () => {
  const src = 'model = "o3"';
  const out = write(src).text;
  assertValid(src, out);
  assert(TOML.parse(out).model === "o3", "model lost");
});

console.log("\n=== refusals ===");
check("root INLINE mcp_servers table -> refuses (cannot be done safely)", () => {
  const src = 'mcp_servers = { other = { command = "x" } }\n';
  let threw = null;
  try { write(src); } catch (e) { threw = e; }
  assert(threw instanceof TomlRefusal, `expected TomlRefusal, got ${threw}`);
  assert(threw.code === "ROOT_INLINE_TABLE", "wrong refusal code");
});
check("root DOTTED sibling -> emits dotted form, stays legal", () => {
  const src = 'mcp_servers.other = { command = "x" }\n\n[tui]\ntheme = "dark"\n';
  const r = write(src);
  assert(r.form === "dotted", `expected dotted form, got ${r.form}`);
  assertValid(src, r.text);
  assert(TOML.parse(r.text).mcp_servers.other.command === "x", "sibling lost");
});

console.log("\n=== near-miss names (prefix/quoting bugs) ===");
check("a server named MultiMCPExtra is NOT deleted", () => {
  const src = `[mcp_servers.MultiMCPExtra]\ncommand = "keep"\n`;
  const out = write(src).text;
  assertValid(src, out);
  assert(TOML.parse(out).mcp_servers.MultiMCPExtra, "deleted a server with a longer name (prefix bug)");
});
check("a quoted server name containing a dot is NOT matched", () => {
  const src = `[mcp_servers."My.MultiMCP"]\ncommand = "keep"\n`;
  const out = write(src).text;
  assertValid(src, out);
  assert(TOML.parse(out).mcp_servers["My.MultiMCP"].command === "keep", "clobbered an unrelated dotted-name server");
});
check("orphan env header BEFORE the parent table is still removed", () => {
  const src = `[mcp_servers.MultiMCP.env]\n${STALE} = "1"\n\n[mcp_servers.MultiMCP]\ncommand = "old"\n`;
  const out = write(src).text;
  assertValid(src, out);
  assert(!out.includes(STALE), "orphan env header survived");
});
check("sentinel BEGIN present but END deleted by the user -> no duplicate block", () => {
  const src = `${SENTINELS.begin}\n[mcp_servers.MultiMCP]\ncommand = "old"\n\n[tui]\ntheme = "dark"\n`;
  const out = write(src).text;
  assertValid(src, out);
  assert((out.match(/>>> MultiMCP/g) || []).length === 1, "sentinel duplicated");
  assert(TOML.parse(out).tui.theme === "dark", "lost [tui]");
});
check("BOM + CRLF + existing entry is idempotent and keeps exactly one BOM", () => {
  const src = BOM + '[mcp_servers.MultiMCP]\r\ncommand = "old"\r\n\r\n[tui]\r\ntheme = "dark"\r\n';
  const a = write(src).text;
  assertValid(src, a);
  assert(a.charCodeAt(0) === 0xfeff, "BOM lost");
  assert((a.match(/﻿/g) || []).length === 1, "BOM duplicated");
  assert(write(a).text === a, "not idempotent with BOM+CRLF");
});

console.log("\n=== the safety net actually catches a bad edit ===");
check("validateEdit rejects an edit that drops another server", () => {
  const src = '[mcp_servers.github]\ncommand = "npx"\n';
  const sabotaged = "[mcp_servers.MultiMCP]\ncommand = 'x'\n"; // github deleted!
  const problems = validateEdit(parseOrNull(src), sabotaged, PATH, EXPECTED);
  assert(problems.length > 0, "validator failed to notice a dropped server");
  assert(problems.some((p) => p.includes("github")), `expected a github complaint, got: ${problems}`);
});
check("validateEdit rejects an edit that leaves a stale env key", () => {
  const good = write("").text;
  const sabotaged = good.replace("[mcp_servers.MultiMCP.env]", "[mcp_servers.MultiMCP.env]\nSTALE = '1'");
  const problems = validateEdit({}, sabotaged, PATH, EXPECTED);
  assert(problems.length > 0, "validator failed to notice a stale env key");
});
check("validateEdit rejects invalid TOML", () => {
  assert(validateEdit({}, "[[[broken", PATH, EXPECTED).length > 0, "validator accepted garbage");
});

console.log("\n=== removeTable (legacy connector cleanup) ===");
check("removes a header-form table plus its .env subtable, keeps siblings + other tables", () => {
  const src =
    '[mcp_servers.google_workspace]\ncommand = "uvx"\nargs = ["workspace-mcp"]\n\n' +
    '[mcp_servers.google_workspace.env]\nWORKSPACE_MCP_PORT = "9000"\nSECRET = "x"\n\n' +
    '[mcp_servers.node_repl]\ncommand = "node"\n\n[tui]\ntheme = "dark"\n';
  const r = removeTable(src, ["mcp_servers", "google_workspace"]);
  assert(r.removed === true, "should report removed");
  const parsed = TOML.parse(r.text);
  assert(!parsed.mcp_servers.google_workspace, "google_workspace survived");
  assert(parsed.mcp_servers.node_repl.command === "node", "sibling server lost");
  assert(parsed.tui.theme === "dark", "unrelated [tui] table lost");
});
check("absent table is a no-op (removed:false, text byte-identical)", () => {
  const src = '[mcp_servers.node_repl]\ncommand = "node"\n';
  const r = removeTable(src, ["mcp_servers", "google_workspace"]);
  assert(r.removed === false, "should report not-removed");
  assert(r.text === src, "text changed on a no-op removal");
});
check("does NOT match a prefix sibling (google_workspace_extra stays)", () => {
  const src =
    '[mcp_servers.google_workspace_extra]\ncommand = "keep"\n\n' +
    '[mcp_servers.google_workspace]\ncommand = "drop"\n';
  const r = removeTable(src, ["mcp_servers", "google_workspace"]);
  const parsed = TOML.parse(r.text);
  assert(parsed.mcp_servers.google_workspace_extra.command === "keep", "clobbered a prefix-named sibling");
  assert(!parsed.mcp_servers.google_workspace, "target not removed");
});
check("legacy-strip then upsert yields ONLY MultiMCP under mcp_servers, valid TOML", () => {
  // Mirrors codexConfig.writeServerEntry: remove google_workspace, then upsert ours.
  const src =
    '[mcp_servers.google_workspace]\ncommand = "uvx"\n\n' +
    '[mcp_servers.google_workspace.env]\nWORKSPACE_MCP_PORT = "9000"\n';
  const stripped = removeTable(src, ["mcp_servers", "google_workspace"]).text;
  const out = upsertTable(stripped, { path: PATH, scalars: SCALARS, subTables: { env: ENV }, sentinels: SENTINELS }).text;
  const parsed = TOML.parse(out);
  assert(!parsed.mcp_servers.google_workspace, "legacy key present in final output");
  assert(parsed.mcp_servers.MultiMCP, "MultiMCP missing from final output");
  assert(Object.keys(parsed.mcp_servers).length === 1, "expected exactly one server after cleanup");
});
check("preserves BOM and CRLF while removing", () => {
  const src = BOM + '[mcp_servers.google_workspace]\r\ncommand = "uvx"\r\n\r\n[tui]\r\ntheme = "dark"\r\n';
  const r = removeTable(src, ["mcp_servers", "google_workspace"]);
  assert(r.text.charCodeAt(0) === 0xfeff, "BOM lost");
  assert(r.eol === "\r\n", "did not detect CRLF");
  // smol-toml rejects a leading BOM (documented), so strip it before parsing, exactly
  // as validateEdit does in production.
  assert(TOML.parse(r.text.replace(/^﻿/, "")).tui.theme === "dark", "lost [tui]");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
