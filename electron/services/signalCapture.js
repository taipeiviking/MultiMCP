// Background Signal message capture, owned by the TRAY APP.
//
// Why here: Signal has no server-side history — a message is only captured if
// something is subscribed to the daemon when it arrives. The MCP servers only
// run while an AI session is open, so capture used to have gaps (and the
// stop-gap external keeper showed a console window). This app autostarts and
// lives in the tray, so it is the natural owner of an always-on, windowless
// capture connection.
//
// It is a deliberate twin of the capture path in
// python/multimcp-signal/src/multimcp_signal/server.py — SAME store file, SAME
// record shape, SAME dedup key (timestamp, source, text) — so messages captured
// here are indistinguishable from ones captured by an MCP server instance, and
// read-side dedup makes concurrent writers safe.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const credentials = require("./credentials");
const signal = require("./signal");
const log = require("./logger");

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 120000;
// The JVM needs time on a cold start; poll the port rather than trusting one try.
const DAEMON_WAIT_MS = 90000;
const LOG_RING_SIZE = 50;

let sock = null;
let running = false;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let subscribed = false;
let lastMessageAt = null;
let capturedThisRun = 0;
const activity = []; // ring buffer of human-readable lines for the dashboard box

function note(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  activity.push(`${stamp}  ${line}`);
  while (activity.length > LOG_RING_SIZE) activity.shift();
}

function capturePath() {
  return path.join(signal.dataDir(), "multimcp", "messages.jsonl");
}

// Mirror of server.py _record_from_envelope — keep the two in sync.
function recordFromEnvelope(env) {
  let data = env.dataMessage;
  let direction = "in";
  if (!data) {
    const sent = env.syncMessage && env.syncMessage.sentMessage;
    if (!sent) return null; // receipts, typing, key changes, ...
    data = sent;
    direction = "out";
  }
  const text = data.message || null;
  const attachments = (data.attachments || []).map((a) => ({
    id: a.id,
    contentType: a.contentType,
    filename: a.filename,
  }));
  if (!text && attachments.length === 0) return null; // reactions/edits
  return {
    timestamp: data.timestamp || env.timestamp,
    direction,
    source: env.sourceNumber || env.source,
    sourceName: env.sourceName || null,
    recipient: direction === "out" ? data.destNumber || null : null,
    groupId: (data.groupInfo && data.groupInfo.groupId) || null,
    text,
    attachments,
  };
}

function appendRecord(rec) {
  const p = capturePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(rec) + "\n");
  lastMessageAt = Date.now();
  capturedThisRun++;
  const who = rec.sourceName || rec.source || "unknown";
  note(rec.direction === "in" ? `message from ${who}` : `sent (from phone) to ${rec.recipient || "group"}`);
}

function handleNotification(params) {
  // Both wire shapes (signal-cli-jsonrpc(5)): subscription-wrapped and bare.
  const inner = params.result || params;
  const s = credentials.readSettings();
  const account = inner.account || params.account;
  if (account && s.signalAccount && account !== s.signalAccount) return;
  const rec = recordFromEnvelope(inner.envelope || {});
  if (rec) appendRecord(rec);
}

// Spawn the shared daemon exactly as the MCP servers do (same pinned port, same
// data dir), detached and windowless — it must outlive this app and never show
// a console. If another process spawned it first, connect() simply succeeds.
function spawnDaemon() {
  const engine = signal.engineStatus();
  if (!engine.ok) return false;
  const logPath = path.join(signal.dataDir(), "multimcp", "daemon.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  try {
    // Direct java invocation — see signal.javaInvocation for why never the .bat.
    const inv = signal.javaInvocation(["daemon", "--tcp", `127.0.0.1:${signal.SIGNAL_DAEMON_PORT}`]);
    const child = spawn(inv.exe, inv.args, {
      env: inv.env,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
    note("starting Signal engine…");
    return true;
  } catch (e) {
    log.warn("signalCapture", "daemon spawn failed", { message: String(e) });
    return false;
  } finally {
    fs.closeSync(out);
  }
}

function connectOnce() {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: signal.SIGNAL_DAEMON_PORT });
    s.once("connect", () => resolve(s));
    s.once("error", () => resolve(null));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(null);
    });
  });
}

async function connectOrSpawn() {
  let s = await connectOnce();
  if (s) return s;
  if (!spawnDaemon()) return null;
  const deadline = Date.now() + DAEMON_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    s = await connectOnce();
    if (s) return s;
  }
  return null;
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectLoop();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function connectLoop() {
  if (!running) return;
  const settings = credentials.readSettings();
  if (!settings.signalAccount || !signal.engineStatus().ok) {
    // Not linked (or engine missing): idle quietly and look again later.
    scheduleReconnect();
    return;
  }
  const s = await connectOrSpawn();
  if (!running) {
    if (s) s.destroy();
    return;
  }
  if (!s) {
    note("engine not reachable — will retry");
    scheduleReconnect();
    return;
  }
  sock = s;
  reconnectDelay = RECONNECT_MIN_MS;
  subscribed = false;
  note("connected to Signal engine");

  let buf = "";
  s.setTimeout(0);
  s.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.id === "sub") {
        subscribed = !obj.error;
        note(subscribed ? "listening for messages" : `subscribe failed: ${obj.error && obj.error.message}`);
        if (!subscribed) log.warn("signalCapture", "subscribeReceive failed", obj.error);
      } else if (obj.method === "receive") {
        try {
          handleNotification(obj.params || {});
        } catch (e) {
          log.warn("signalCapture", "capture failed", { message: String(e) });
        }
      }
    }
  });
  const drop = () => {
    if (sock === s) {
      sock = null;
      subscribed = false;
      note("connection lost");
      scheduleReconnect();
    }
  };
  s.on("close", drop);
  s.on("error", drop);

  // The multi-account daemon pushes nothing until a client subscribes.
  s.write(
    JSON.stringify({ jsonrpc: "2.0", id: "sub", method: "subscribeReceive", params: { account: settings.signalAccount } }) + "\n"
  );
}

function start() {
  if (running) return;
  running = true;
  log.info("signalCapture", "background capture starting");
  connectLoop();
}

function stop() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (sock) {
    try {
      sock.destroy();
    } catch {}
    sock = null;
  }
  // The daemon deliberately stays: other linked clients (an open AI session)
  // may still be using it, and it keeps the device in sync.
}

// Read-side dedup twin of server.py _read_capture (concurrent writers append
// the same notification; the key makes that harmless).
function storeSummary() {
  let count = 0;
  let last = null;
  try {
    const seen = new Set();
    for (const line of fs.readFileSync(capturePath(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const key = `${rec.timestamp}|${rec.source}|${rec.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
      if (!last || (rec.timestamp || 0) > last) last = rec.timestamp;
    }
  } catch {
    /* no store yet */
  }
  return { count, lastTimestamp: last };
}

function getStatus() {
  const { count, lastTimestamp } = storeSummary();
  return {
    running,
    connected: !!sock,
    subscribed,
    storedMessages: count,
    lastMessageAt: lastTimestamp || lastMessageAt,
    capturedThisRun,
    activity: activity.slice(-15),
  };
}

module.exports = { start, stop, getStatus };
