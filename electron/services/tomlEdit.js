// Surgical TOML editing: replace ONE table in a file without disturbing a byte
// of anything else.
//
// WHY NOT parse -> mutate -> stringify? Because no JS TOML library round-trips
// COMMENTS. smol-toml, @iarna/toml and @ltd/j-toml all discard them on
// stringify. ~/.codex/config.toml is a hand-maintained file (model, approval
// policy, other MCP servers, and the user's notes about all of it). Regenerating
// it from a parsed AST would silently delete every comment in it. So we edit
// TEXT -- cutting and splicing byte ranges -- and use a real parser for
// VALIDATION ONLY. (Rust's toml_edit does format-preserving round-trips; JS has
// no equivalent. Hence this file.)
//
// THE CENTRAL SAFETY PROPERTY
//   The scanner below does NOT need to be a perfect TOML parser. It needs to be
//   good enough that its mistakes are DETECTED. Every edit is re-parsed and
//   diffed against the original parse before it may reach the disk (validateEdit).
//   A scanner bug therefore degrades to "we refuse to write", never to "we
//   corrupted your config". Design the checker to be simpler than the editor.
//
// TRAPS HANDLED (all are legal TOML; all defeat the obvious regex/line-based
// implementation; each has a test in tomlEdit.test.js):
//
//   1. A line starting with '[' is NOT necessarily a table header. It can be a
//      row of a multi-line array:        x = [
//                                        [1, 2],
//                                        ]
//      ...or a line inside a multi-line string -- which can even contain a
//      convincing FAKE header:           x = """
//                                        [mcp_servers.MultiMCP]
//                                        """
//      "Delete from [mcp_servers.MultiMCP] to the next line starting with [" cuts
//      a hole through the middle of that string literal. VERIFIED: both shapes
//      parse fine, so this is not theoretical.
//   2. One table, many spellings: [mcp_servers.MultiMCP], [ mcp_servers . MultiMCP ],
//      [mcp_servers."MultiMCP"], ["mcp_servers".MultiMCP]. VERIFIED equivalent.
//      Text-matching "[mcp_servers.MultiMCP]" misses stale entries -- and a missed
//      stale entry is a duplicate-table error that breaks the whole file.
//   3. Four ways to express the entry: std table; root dotted key
//      (mcp_servers.MultiMCP = {...}); a key inside [mcp_servers]
//      (MultiMCP = {...}); dotted keys inside [mcp_servers] (MultiMCP.command = ...).
//   4. Our .env may be a SEPARATE [mcp_servers.MultiMCP.env] header elsewhere in
//      the file. Remove the parent but not the .env and the orphan resurrects a
//      stale env var -- exactly the failure mode we are trying to prevent.
//   5. Comments and blank lines inside and around the block.
//   6. CRLF vs LF; BOM (smol-toml does NOT strip it and throws -- VERIFIED); no
//      trailing newline.
//   7. mcp_servers defined as a ROOT INLINE TABLE (mcp_servers = { Other = {...} }).
//      Then NEITHER [mcp_servers.MultiMCP] NOR mcp_servers.MultiMCP = {...} is
//      legal -- both "redefine an already defined table". VERIFIED. We refuse.

// Parser used for VALIDATION ONLY -- never to regenerate the file (it would drop
// every comment). smol-toml: zero dependencies, TOML 1.0.0 compliant, real CJS
// entry point (dist/index.cjs) so it require()s cleanly from Electron's main
// process. @iarna/toml (TOML 0.5, unmaintained) is the common alternative and is
// the wrong choice here.
const TOML = require("smol-toml");

const KEY_CHAR = /[A-Za-z0-9_-]/;
const BOM = "﻿";

// ---------------------------------------------------------------------------
// Low-level skippers: take (text, i) at the construct's first char, return the
// index one past its last char.
// ---------------------------------------------------------------------------

function skipInlineWs(text, i) {
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

// Index just past the newline ending the line containing i.
function endOfLine(text, i) {
  while (i < text.length && text[i] !== "\n") i++;
  return i < text.length ? i + 1 : i;
}

function skipBasicString(text, i) {
  i++; // opening "
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; } // \" \\ \n ...
    if (c === '"') return i + 1;
    if (c === "\n") throw new Error("unterminated basic string");
    i++;
  }
  throw new Error("unterminated basic string");
}

function skipLiteralString(text, i) {
  i++; // opening '
  while (i < text.length) {
    if (text[i] === "'") return i + 1;
    if (text[i] === "\n") throw new Error("unterminated literal string");
    i++;
  }
  throw new Error("unterminated literal string");
}

// """...""" or '''...'''. THE construct that makes a line-based scanner unsound:
// its body may contain anything, including lines that look exactly like headers.
function skipMultilineString(text, i, delim) {
  const escapes = delim === '"""'; // literal ''' strings have no escapes
  i += 3;
  while (i < text.length) {
    if (escapes && text[i] === "\\") { i += 2; continue; }
    if (text.startsWith(delim, i)) {
      i += 3;
      // TOML allows up to 2 extra quote chars immediately before the closing
      // delimiter, e.g. """he said "hi"""" ends with a quote inside the string.
      let extra = 0;
      while (extra < 2 && text[i] === delim[0]) { i++; extra++; }
      return i;
    }
    i++;
  }
  throw new Error("unterminated multi-line string");
}

// Arrays [...] and inline tables {...}: may nest, span lines, and contain
// strings and # comments.
function skipBracketed(text, i) {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { i = text.startsWith('"""', i) ? skipMultilineString(text, i, '"""') : skipBasicString(text, i); continue; }
    if (c === "'") { i = text.startsWith("'''", i) ? skipMultilineString(text, i, "'''") : skipLiteralString(text, i); continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "[" || c === "{") { depth++; i++; continue; }
    if (c === "]" || c === "}") { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  throw new Error("unterminated array or inline table");
}

function skipValue(text, i) {
  i = skipInlineWs(text, i);
  const c = text[i];
  if (c === undefined) throw new Error("missing value");
  if (c === '"') return text.startsWith('"""', i) ? skipMultilineString(text, i, '"""') : skipBasicString(text, i);
  if (c === "'") return text.startsWith("'''", i) ? skipMultilineString(text, i, "'''") : skipLiteralString(text, i);
  if (c === "[" || c === "{") return skipBracketed(text, i);
  while (i < text.length && !",]}#\n\r".includes(text[i])) i++; // number / bool / datetime
  return i;
}

function unescapeBasic(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, g) => {
    const map = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (map[g] !== undefined) return map[g];
    if (g[0] === "u" || g[0] === "U") return String.fromCodePoint(parseInt(g.slice(1), 16));
    return g;
  });
}

// Dotted key path with bare / "basic" / 'literal' parts and whitespace allowed
// around the dots. Parts are DECODED, so every legal spelling of a path compares
// equal (trap 2).
function parseKeyPath(text, i) {
  const parts = [];
  for (;;) {
    i = skipInlineWs(text, i);
    const c = text[i];
    if (c === '"') {
      const end = skipBasicString(text, i);
      parts.push(unescapeBasic(text.slice(i + 1, end - 1)));
      i = end;
    } else if (c === "'") {
      const end = skipLiteralString(text, i);
      parts.push(text.slice(i + 1, end - 1));
      i = end;
    } else if (c !== undefined && KEY_CHAR.test(c)) {
      const start = i;
      while (i < text.length && KEY_CHAR.test(text[i])) i++;
      parts.push(text.slice(start, i));
    } else {
      throw new Error(`bad key at offset ${i}`);
    }
    const j = skipInlineWs(text, i);
    if (text[j] === ".") { i = j + 1; continue; }
    return { parts, end: i };
  }
}

// ---------------------------------------------------------------------------
// scan(): split the document into top-level statements with byte ranges.
// Once the file is a list of statements, "replace our table" becomes "cut these
// byte ranges and splice", and no pattern match ever gets near a string's guts.
// ---------------------------------------------------------------------------

function scan(text) {
  const items = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const j = skipInlineWs(text, i);
    const c = text[j];

    if (c === undefined || c === "\n" || c === "\r") {
      const end = endOfLine(text, j);
      items.push({ kind: "blank", start, end });
      i = end;
    } else if (c === "#") {
      const end = endOfLine(text, j);
      items.push({ kind: "comment", start, end, text: text.slice(j, end).trim() });
      i = end;
    } else if (c === "[") {
      const aot = text.startsWith("[[", j); // [[array.of.tables]]
      const { parts, end } = parseKeyPath(text, j + (aot ? 2 : 1));
      const k = skipInlineWs(text, end);
      const close = aot ? "]]" : "]";
      if (!text.startsWith(close, k)) throw new Error(`unterminated table header at offset ${j}`);
      const lineEnd = endOfLine(text, k + close.length);
      items.push({ kind: "header", start, end: lineEnd, path: parts, arrayOfTables: aot });
      i = lineEnd;
    } else {
      const key = parseKeyPath(text, j);
      const eq = skipInlineWs(text, key.end);
      if (text[eq] !== "=") throw new Error(`expected '=' at offset ${eq}`);
      const lineEnd = endOfLine(text, skipValue(text, eq + 1));
      items.push({ kind: "keyval", start, end: lineEnd, keyPath: key.parts });
      i = lineEnd;
    }
    if (i <= start) throw new Error("scanner made no progress"); // cannot hang
  }
  return items;
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------

// VERIFIED: smol-toml does not strip a BOM -- it reports it as an illegal key
// character and throws. So a BOM'd config.toml would fail our own validation on
// a perfectly good file. Strip it for parsing; put it back on write so the user
// gets the same encoding they gave us.
function splitBom(raw) {
  return raw.startsWith(BOM) ? { bom: BOM, text: raw.slice(1) } : { bom: "", text: raw };
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (crlf === 0 && lf === 0) return "\n"; // new/empty file: LF, matching Codex's own writer
  return crlf > lf ? "\r\n" : "\n";
}

// ---------------------------------------------------------------------------
// Value emission.
// ---------------------------------------------------------------------------

// Control chars a TOML literal string cannot carry (tab is legal in both forms).
const CTRL_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// WINDOWS PATHS ARE THE WHOLE REASON THIS FUNCTION EXISTS.
//
// A basic string needs every backslash doubled: "C:\\Users\\class\\uvx.exe".
// Get it wrong once and TOML reads \U as a unicode escape and either throws or
// silently mangles the path. A LITERAL string performs NO escape processing, so
// 'C:\Users\class\uvx.exe' is exactly the bytes we meant. Literal is safer, so
// we prefer it: it makes the entire double-escaping bug class unreachable.
//
// But "always use literal" is itself a latent bug: literal strings have NO
// escape mechanism at all, so they cannot contain a single quote, a newline, or
// a control char. The first value containing an apostrophe would produce a
// broken or, worse, a silently truncated file. So: literal when we can, a
// fully-escaped basic string when we must.
function tomlString(value) {
  const s = String(value);
  CTRL_G.lastIndex = 0; // /g + .test() is stateful; reset before every use
  if (!CTRL_G.test(s) && !/['\n\r]/.test(s)) return `'${s}'`;
  CTRL_G.lastIndex = 0;
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\") // MUST be first, or we escape our own escapes
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(CTRL_G, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) +
    '"'
  );
}

function tomlKey(k) {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return '"' + String(k).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function tomlValue(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(tomlValue).join(", ") + "]";
  return tomlString(v);
}

// ---------------------------------------------------------------------------
// upsertTable(): the operation we actually want.
// ---------------------------------------------------------------------------

class TomlRefusal extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TomlRefusal";
    this.code = code;
  }
}

const startsWithPath = (path, prefix) =>
  path.length >= prefix.length && prefix.every((p, i) => path[i] === p);

// Merge overlapping/adjacent ranges and cut them out of the text.
function cutRanges(text, ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    out += text.slice(pos, s);
    pos = e;
  }
  return out + text.slice(pos);
}

// Compute the byte ranges that define `path` (or any of its children).
//
// SUBTLETY -- the trailing-comment trap. The naive "a section runs to the next
// header" rule would delete this user comment:
//
//     [mcp_servers.MultiMCP]
//     command = 'x'
//
//     # notes about my TUI settings   <-- belongs to [tui], NOT to us
//     [tui]
//
// So a section's deletion stops after its LAST KEYVAL, then extends over
// following BLANK lines only (so repeated writes don't accumulate whitespace)
// and halts at the first comment. Consequence: a comment a user hand-wrote at
// the END of a hand-written block is orphaned rather than deleted. That is the
// correct direction to fail -- we would rather leave a stray comment than
// destroy one. Blocks WE wrote are sentinel-wrapped and removed exactly.
function planRemoval(items, path, sentinels) {
  const ranges = [];

  // 1. A block we previously wrote, identified by its sentinel comments.
  if (sentinels) {
    const b = items.findIndex((it) => it.kind === "comment" && it.text === sentinels.begin);
    if (b !== -1) {
      const e = items.findIndex((it, i) => i > b && it.kind === "comment" && it.text === sentinels.end);
      if (e !== -1) {
        let end = items[e].end;
        for (let k = e + 1; k < items.length && items[k].kind === "blank"; k++) end = items[k].end;
        ranges.push([items[b].start, end]);
      } else {
        ranges.push([items[b].start, items[b].end]); // lone sentinel: it is ours, drop the line
      }
    }
  }

  // 2. Structural removal: anything a previous version of us, another tool, or
  //    the user wrote in any of the four legal shapes.
  let section = []; // current table path
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "header") {
      section = it.path;
      if (!startsWithPath(it.path, path)) continue;

      // Whole section: header + body, per the trailing-comment rule above.
      let end = it.end;
      let lastKeyval = -1;
      let k = i + 1;
      for (; k < items.length && items[k].kind !== "header"; k++) {
        if (items[k].kind === "keyval") lastKeyval = k;
      }
      if (lastKeyval !== -1) {
        end = items[lastKeyval].end;
        for (let m = lastKeyval + 1; m < items.length && items[m].kind === "blank"; m++) end = items[m].end;
      } else {
        for (let m = i + 1; m < items.length && items[m].kind === "blank"; m++) end = items[m].end;
      }
      ranges.push([it.start, end]);
      continue;
    }
    if (it.kind !== "keyval") continue;

    // A key line. Its FULL path is the enclosing table path + its own key path.
    // Covers: root `mcp_servers.MultiMCP = {...}`, `MultiMCP = {...}` inside
    // [mcp_servers], and `MultiMCP.command = ...` inside [mcp_servers].
    const full = section.concat(it.keyPath);
    if (startsWithPath(full, path)) ranges.push([it.start, it.end]);
  }
  return ranges;
}

// How is the parent table (`path[0]`, e.g. mcp_servers) defined in what REMAINS
// after removal? That decides the only form we may legally emit.
//
// VERIFIED with smol-toml:
//   [mcp_servers] / [mcp_servers.Other] present  -> [mcp_servers.MultiMCP] LEGAL
//   root dotted `mcp_servers.Other = {...}`      -> [mcp_servers.MultiMCP] parses,
//        but the spec is ambiguous about super-tables created by dotted keys and
//        implementations disagree. Codex uses Rust toml_edit, not smol-toml, so a
//        pass from OUR validator would not prove Codex accepts it. We therefore
//        emit the DOTTED form here, which is unambiguously legal -- match the
//        shape the file already uses instead of betting on a contested corner.
//   root inline `mcp_servers = { ... }`          -> BOTH forms ILLEGAL
//        ("trying to redefine an already defined table"). Adding a member would
//        mean rewriting the user's inline table in place. We refuse instead.
function chooseForm(items, parent) {
  let seenHeader = false;
  let rootInline = false;
  let rootDotted = false;
  let headerUnderParent = false;

  for (const it of items) {
    if (it.kind === "header") { seenHeader = true; if (it.path[0] === parent) headerUnderParent = true; continue; }
    if (it.kind !== "keyval" || seenHeader) continue; // root scope = before the first header
    if (it.keyPath[0] !== parent) continue;
    if (it.keyPath.length === 1) rootInline = true;
    else rootDotted = true;
  }

  if (rootInline) {
    throw new TomlRefusal(
      `"${parent}" is defined as an inline table at the top of the file ` +
        `(${parent} = { ... }). TOML does not allow adding keys to an inline table, ` +
        `so this entry cannot be added without rewriting your other servers. ` +
        `Convert it to [${parent}.<name>] sections, or paste the block below in by hand.`,
      "ROOT_INLINE_TABLE"
    );
  }
  if (rootDotted && !headerUnderParent) return "dotted";
  return "header";
}

// Where a dotted key must go: the root table ends at the first header. Insert
// BEFORE any comment/blank run leading up to that header, so we do not wedge our
// block between a comment and the header it documents.
function rootInsertOffset(items, text) {
  const h = items.findIndex((it) => it.kind === "header");
  if (h === -1) return text.length;
  let i = h;
  while (i > 0 && (items[i - 1].kind === "comment" || items[i - 1].kind === "blank")) i--;
  return items[i].start;
}

function renderBlock(form, path, scalars, subTables, sentinels, eol) {
  const L = [];
  if (sentinels) L.push(sentinels.begin);

  if (form === "header") {
    L.push(`[${path.map(tomlKey).join(".")}]`);
    for (const [k, v] of Object.entries(scalars)) L.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    for (const [name, tbl] of Object.entries(subTables)) {
      L.push("");
      L.push(`[${path.concat(name).map(tomlKey).join(".")}]`);
      for (const [k, v] of Object.entries(tbl)) L.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    }
  } else {
    // Dotted form: one line, everything inline. TOML forbids newlines inside an
    // inline table, so this cannot be pretty-printed -- it must stay on one line.
    const inner = Object.entries(scalars).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    for (const [name, tbl] of Object.entries(subTables)) {
      const kv = Object.entries(tbl).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
      inner.push(`${tomlKey(name)} = { ${kv.join(", ")} }`);
    }
    L.push(`${path.map(tomlKey).join(".")} = { ${inner.join(", ")} }`);
  }

  if (sentinels) L.push(sentinels.end);
  return L.join(eol) + eol;
}

/**
 * Replace (or insert) one table, preserving everything else byte-for-byte.
 *
 * @returns {{ text: string, form: string, replaced: boolean, eol: string, bom: string }}
 * @throws  {TomlRefusal} when the file's shape makes a safe edit impossible.
 */
function upsertTable(raw, { path, scalars, subTables = {}, sentinels = null }) {
  const { bom, text } = splitBom(raw);
  const eol = detectEol(text);
  const items = scan(text); // throws on a file we cannot understand -> caller refuses

  const removals = planRemoval(items, path, sentinels);
  const body = cutRanges(text, removals);

  // Re-scan the REMAINS: the emission form depends on what is actually left, not
  // on what was there before (e.g. if the only mcp_servers content WAS our entry,
  // the parent is now gone and the plain header form is right again).
  const remaining = scan(body);
  const form = chooseForm(remaining, path[0]);
  const block = renderBlock(form, path, scalars, subTables, sentinels, eol);

  let out;
  if (form === "dotted") {
    const at = rootInsertOffset(remaining, body);
    out = body.slice(0, at) + block + (at === body.length ? "" : eol) + body.slice(at);
  } else {
    let head = body;
    if (head.length && !head.endsWith("\n")) head += eol; // file had no trailing newline
    if (head.trim().length) head = head.replace(/(\r?\n)*$/, eol + eol); // exactly one blank line before us
    out = head + block;
  }

  return { text: bom + out, form, replaced: removals.length > 0, eol, bom };
}

/**
 * Remove one table (and its children) by path, preserving everything else
 * byte-for-byte. Used to drop a legacy connector entry (e.g. the old
 * `google_workspace`) before upserting the current one -- that removal cannot be
 * folded into upsertTable, because validateEdit forbids any sibling under the
 * parent from changing during our write, and would (correctly) reject it.
 *
 * Structural removal only (no sentinels): it matches whatever legal shape the
 * table takes -- `[mcp_servers.foo]` + `[mcp_servers.foo.env]`, a root dotted
 * `mcp_servers.foo = {...}`, or `mcp_servers.foo.command = ...`. Returns the input
 * unchanged with removed:false when `path` is absent.
 *
 * @returns {{ text: string, removed: boolean, bom: string, eol: string }}
 */
function removeTable(raw, path) {
  const { bom, text } = splitBom(raw);
  const eol = detectEol(text);
  const items = scan(text); // throws on a file we cannot understand -> caller refuses
  const ranges = planRemoval(items, path, null);
  if (!ranges.length) return { text: raw, removed: false, bom, eol };
  const body = cutRanges(text, ranges);
  return { text: bom + body, removed: true, bom, eol };
}

// ---------------------------------------------------------------------------
// validateEdit(): the safety net that lets the scanner above be pragmatic.
//
// Prove, by RE-PARSING with a real TOML parser, that the edited text (a) is valid
// TOML, (b) contains exactly the table we meant to write, and (c) left everything
// else alone. Any slicing bug in the editor surfaces here as a diff, and a diff
// means we refuse to write. The checker shares NO code with the editor -- that
// independence is the point.
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const getIn = (obj, p) => p.reduce((o, k) => (o == null ? o : o[k]), obj);

/** @returns {string[]} problems; empty means the edit is safe to persist. */
function validateEdit(oldParsed, newText, path, expected) {
  const problems = [];
  const label = path.join(".");

  let now;
  try {
    now = TOML.parse(splitBom(newText).text);
  } catch (e) {
    return [`result is not valid TOML: ${e.message}`];
  }

  // (b) Our table is EXACTLY what we meant -- no more, no less. A stale env key
  //     surviving a rewrite is precisely what this assertion forbids.
  const ours = getIn(now, path);
  if (!ours) {
    problems.push(`${label} missing from the result`);
  } else if (!deepEqual(ours, expected)) {
    const got = Object.keys(ours.env || {}).sort().join(",");
    const want = Object.keys(expected.env || {}).sort().join(",");
    problems.push(`${label} does not match what we wrote (env got [${got}] want [${want}])`);
  }

  // (c) Every OTHER top-level table survived, none invented, none dropped.
  const parent = path[0];
  for (const k of Object.keys(oldParsed)) {
    if (k === parent) continue;
    if (!deepEqual(oldParsed[k], now[k])) problems.push(`top-level "${k}" changed or was lost`);
  }
  for (const k of Object.keys(now)) {
    if (k !== parent && !Object.prototype.hasOwnProperty.call(oldParsed, k)) {
      problems.push(`top-level "${k}" appeared unexpectedly`);
    }
  }

  // ...and every sibling under the parent table (i.e. the user's OTHER MCP servers).
  const key = path[path.length - 1];
  const oldSiblings = oldParsed[parent] || {};
  const newSiblings = now[parent] || {};
  for (const k of Object.keys(oldSiblings)) {
    if (k === key) continue;
    if (!deepEqual(oldSiblings[k], newSiblings[k])) problems.push(`${parent}."${k}" changed or was lost`);
  }
  for (const k of Object.keys(newSiblings)) {
    if (k !== key && !Object.prototype.hasOwnProperty.call(oldSiblings, k)) {
      problems.push(`${parent}."${k}" appeared unexpectedly`);
    }
  }

  return problems;
}

function parseOrNull(raw) {
  try {
    return TOML.parse(splitBom(raw).text);
  } catch {
    return null;
  }
}

module.exports = {
  scan,
  splitBom,
  detectEol,
  tomlString,
  tomlKey,
  tomlValue,
  upsertTable,
  removeTable,
  validateEdit,
  parseOrNull,
  deepEqual,
  cutRanges,
  planRemoval,
  TomlRefusal,
  BOM,
};
