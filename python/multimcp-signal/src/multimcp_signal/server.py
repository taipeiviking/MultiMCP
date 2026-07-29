"""MCP server exposing Signal messenger to AI clients (Claude Desktop, Codex).

Architecture (see docs/SIGNAL_PLAN.md in the MultiMCP repo):

- signal-cli owns all Signal protocol state in SIGNAL_CONFIG_DIR and LOCKS that
  dir — only one process may use it. But every MCP client spawns its own copy
  of this server, so the servers must SHARE one signal-cli. They do so through
  signal-cli's daemon mode: a JSON-RPC interface on a pinned localhost TCP port.

- Connect-first, spawn-if-absent: each instance first tries to connect to the
  daemon; only if nothing is listening does it spawn one (detached, so it
  outlives this process and keeps receiving messages between sessions). If two
  instances race, the loser's daemon exits on the port/lock conflict and its
  connect-retry lands on the winner's daemon.

- Message history: Signal has no server-side history to query — a linked device
  only sees what arrives while something is receiving. The daemon pushes
  incoming messages as JSON-RPC notifications; every connected instance appends
  them to a shared JSONL capture file (deduplicated on read, since the daemon
  broadcasts to all connections). Search/read tools work over this capture, so
  coverage starts the day the connector is first used.

Environment contract (written by the MultiMCP tray app into the client config):
  SIGNAL_ACCOUNT      E.164 number of the linked account (+4917...)
  SIGNAL_CLI_PATH     absolute path to signal-cli launcher (.bat on Windows)
  SIGNAL_JAVA_HOME    JRE for signal-cli
  SIGNAL_CONFIG_DIR   signal-cli data dir (shared with the tray app)
  SIGNAL_DAEMON_PORT  pinned TCP port for the shared daemon (default 7583)
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from mcp.server.mcpserver import MCPServer

HOST = "127.0.0.1"
CONNECT_TIMEOUT_S = 2.0
# A cold daemon start = JVM boot + Signal websocket connect; generous on purpose.
DAEMON_START_TIMEOUT_S = 90.0
RPC_TIMEOUT_S = 60.0

ACCOUNT = os.environ.get("SIGNAL_ACCOUNT", "")
CLI_PATH = os.environ.get("SIGNAL_CLI_PATH", "")
JAVA_HOME = os.environ.get("SIGNAL_JAVA_HOME", "")
CONFIG_DIR = os.environ.get("SIGNAL_CONFIG_DIR", "")
PORT = int(os.environ.get("SIGNAL_DAEMON_PORT", "7583"))

CAPTURE_PATH = Path(CONFIG_DIR or ".") / "multimcp" / "messages.jsonl"


def _log(msg: str) -> None:
    # stderr only: stdout is the MCP stdio transport and must stay clean.
    print(f"[multimcp-signal] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Daemon lifecycle
# --------------------------------------------------------------------------


def _try_connect(timeout: float = CONNECT_TIMEOUT_S) -> socket.socket | None:
    try:
        sock = socket.create_connection((HOST, PORT), timeout=timeout)
        sock.settimeout(None)
        return sock
    except OSError:
        return None


def _spawn_daemon() -> None:
    """Start the shared signal-cli daemon, detached so it survives this process.

    Persisting is the point: the daemon keeps RECEIVING while no AI session is
    open, which both keeps the linked device in sync and fills the capture file
    other sessions read from.
    """
    if not (CLI_PATH and os.path.exists(CLI_PATH)):
        raise RuntimeError(f"SIGNAL_CLI_PATH does not exist: {CLI_PATH!r}")
    args = ["--config", CONFIG_DIR, "daemon", "--tcp", f"{HOST}:{PORT}"]
    if os.name == "nt":
        # NEVER the shipped .bat on Windows: it expands a ~100-jar CLASSPATH
        # inline and blows cmd.exe's 8191-char line limit from the installed
        # app's long path ("The input line is too long"). Invoke java directly;
        # the wildcard classpath is expanded by java itself. Mirrors
        # electron/services/signal.js javaInvocation — keep the two in sync.
        lib_dir = Path(CLI_PATH).parent.parent / "lib"
        java_exe = Path(JAVA_HOME) / "bin" / "java.exe" if JAVA_HOME else Path("java.exe")
        cmd = [str(java_exe), "-classpath", f"{lib_dir}\\*", "org.asamk.signal.Main", *args]
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NO_WINDOW
            # DETACHED alone is NOT enough: MCP clients (Claude Code observed)
            # put their server processes in a Job Object with kill-on-close, and
            # jobs reap detached children too. Breakaway is what actually lets
            # the daemon outlive the MCP server that spawned it.
            | 0x01000000  # CREATE_BREAKAWAY_FROM_JOB
        )
    else:
        cmd = [CLI_PATH, *args]
        creationflags = 0
    env = dict(os.environ)
    if JAVA_HOME:
        env["JAVA_HOME"] = JAVA_HOME
    log_path = Path(CONFIG_DIR) / "multimcp" / "daemon.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "ab") as log_file:
        try:
            subprocess.Popen(
                cmd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                creationflags=creationflags,
                close_fds=True,
            )
        except OSError:
            # Breakaway is refused when the enclosing Job forbids it — spawn
            # without it rather than not at all (the daemon then shares the
            # spawner's fate, which connect-or-respawn recovers from anyway).
            subprocess.Popen(
                cmd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                creationflags=creationflags & ~0x01000000,
                close_fds=True,
            )
    _log(f"spawned signal-cli daemon on {HOST}:{PORT} (log: {log_path})")


def _connect_or_spawn() -> socket.socket:
    sock = _try_connect()
    if sock:
        return sock
    _spawn_daemon()
    deadline = time.monotonic() + DAEMON_START_TIMEOUT_S
    while time.monotonic() < deadline:
        # If we lost a spawn race, our daemon dies on the lock/port conflict and
        # this connect succeeds against the survivor — same outcome either way.
        sock = _try_connect()
        if sock:
            return sock
        time.sleep(1.0)
    raise RuntimeError(
        f"signal-cli daemon did not become reachable on {HOST}:{PORT} "
        f"within {DAEMON_START_TIMEOUT_S:.0f}s — see daemon.log in the Signal data dir"
    )


# --------------------------------------------------------------------------
# JSON-RPC client (newline-delimited over TCP) + notification capture
# --------------------------------------------------------------------------


class Rpc:
    def __init__(self) -> None:
        self._sock: socket.socket | None = None
        self._reader: threading.Thread | None = None
        self._lock = threading.Lock()  # request bookkeeping + socket writes
        self._next_id = 1
        self._pending: dict[int, dict] = {}
        self._events: dict[int, threading.Event] = {}
        self.new_message = threading.Condition()

    def ensure(self) -> None:
        fresh = False
        with self._lock:
            if self._sock is None:
                self._sock = _connect_or_spawn()
                self._reader = threading.Thread(target=self._read_loop, daemon=True)
                self._reader.start()
                fresh = True
        if fresh:
            # In multi-account daemon mode the daemon pushes NOTHING until the
            # client subscribes (signal-cli-jsonrpc(5)) — verified live: without
            # this, sends work but no "receive" notification ever arrives and
            # capture stays silently empty. (_retried=True: no reconnect loop —
            # the nested ensure() sees the socket we just set and returns.)
            try:
                self.call("subscribeReceive", {"account": ACCOUNT}, _retried=True)
                _log("subscribed to receive notifications")
            except Exception as e:
                _log(f"subscribeReceive failed — message capture disabled: {e}")

    def _read_loop(self) -> None:
        assert self._sock is not None
        try:
            f = self._sock.makefile("r", encoding="utf-8", errors="replace")
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if "id" in obj and obj["id"] is not None:
                    with self._lock:
                        rid = obj["id"]
                        self._pending[rid] = obj
                        ev = self._events.get(rid)
                    if ev:
                        ev.set()
                elif obj.get("method") == "receive":
                    self._capture(obj.get("params") or {})
        except OSError as e:
            # A hard kill of the daemon raises here rather than yielding EOF.
            # Without this handler the thread died silently, _sock stayed set,
            # and every later call "worked" against a dead connection — observed
            # live as get_recent_messages returning [] forever after a reboot.
            _log(f"daemon connection lost: {e}")
        finally:
            with self._lock:
                self._sock = None
                # Wake anyone mid-call; they find no response and raise cleanly.
                for ev in self._events.values():
                    ev.set()
            _log("daemon connection closed")

    def call(self, method: str, params: dict | None = None, _retried: bool = False) -> dict:
        self.ensure()
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            ev = threading.Event()
            self._events[rid] = ev
            payload = {"jsonrpc": "2.0", "id": rid, "method": method}
            if params:
                payload["params"] = params
            data = (json.dumps(payload) + "\n").encode("utf-8")
            sock = self._sock
        try:
            if sock is None:
                raise OSError("no daemon connection")
            sock.sendall(data)
            if not ev.wait(RPC_TIMEOUT_S):
                raise RuntimeError(f"signal-cli did not answer {method!r} within {RPC_TIMEOUT_S:.0f}s")
            with self._lock:
                resp = self._pending.pop(rid, None)
            if resp is None:
                # Reader thread woke us on connection loss, not with an answer.
                raise OSError("connection to signal-cli daemon was lost mid-call")
        except OSError:
            # Stale socket (daemon died since we connected). Reconnect — which
            # respawns the daemon if needed — and retry ONCE. Sends are the only
            # non-idempotent method; a lost connection before a response means
            # the send may not have happened, so one retry is the right risk.
            if _retried:
                raise
            with self._lock:
                self._sock = None
            return self.call(method, params, _retried=True)
        finally:
            with self._lock:
                self._events.pop(rid, None)
        if "error" in resp:
            err = resp["error"]
            raise RuntimeError(f"signal-cli error {err.get('code')}: {err.get('message')}")
        return resp.get("result") or {}

    # -- capture ------------------------------------------------------------

    def _capture(self, params: dict) -> None:
        """Persist an incoming envelope to the shared JSONL capture file.

        Two wire shapes (signal-cli-jsonrpc(5)): auto-receive notifications carry
        the envelope directly in params; subscription-based ones (multi-account
        daemon — our case) wrap it as params.result.envelope.
        """
        inner = params.get("result") or params
        account = inner.get("account") or params.get("account")
        if account and ACCOUNT and account != ACCOUNT:
            return
        env = inner.get("envelope") or {}
        rec = _record_from_envelope(env)
        if rec is None:
            return
        try:
            CAPTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(CAPTURE_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError as e:
            _log(f"could not append to capture file: {e}")
            return
        with self.new_message:
            self.new_message.notify_all()


def _record_from_envelope(env: dict) -> dict | None:
    """Flatten a signal-cli envelope to what the tools need; None = not a message.

    Two shapes matter: dataMessage (someone wrote to us) and
    syncMessage.sentMessage (the user wrote from their phone — captured too so
    conversations read complete, not half).
    """
    data = env.get("dataMessage")
    direction = "in"
    if data is None:
        sent = (env.get("syncMessage") or {}).get("sentMessage")
        if sent is None:
            return None  # receipts, typing indicators, key changes, ...
        data = sent
        direction = "out"
    text = data.get("message")
    attachments = [
        {"id": a.get("id"), "contentType": a.get("contentType"), "filename": a.get("filename")}
        for a in data.get("attachments") or []
    ]
    if not text and not attachments:
        return None  # reactions/edits/empty service messages
    group = (data.get("groupInfo") or {}).get("groupId")
    return {
        "timestamp": data.get("timestamp") or env.get("timestamp"),
        "direction": direction,
        "source": env.get("sourceNumber") or env.get("source"),
        "sourceName": env.get("sourceName"),
        "recipient": data.get("destNumber") if direction == "out" else None,
        "groupId": group,
        "text": text,
        "attachments": attachments,
    }


RPC = Rpc()


def _read_capture() -> list[dict]:
    """All captured messages, deduplicated (the daemon broadcasts notifications
    to every connected instance, so the same message may be appended twice)."""
    if not CAPTURE_PATH.exists():
        return []
    seen: set[tuple] = set()
    out: list[dict] = []
    with open(CAPTURE_PATH, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            key = (rec.get("timestamp"), rec.get("source"), rec.get("text"))
            if key in seen:
                continue
            seen.add(key)
            out.append(rec)
    out.sort(key=lambda r: r.get("timestamp") or 0)
    return out


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------

mcp = MCPServer("MultiMCP Signal")


@mcp.tool()
def list_contacts() -> list[dict]:
    """List Signal contacts known to the linked account (number, name, profile name)."""
    result = RPC.call("listContacts", {"account": ACCOUNT})
    out = []
    for c in result if isinstance(result, list) else []:
        out.append(
            {
                "number": c.get("number"),
                "name": c.get("name"),
                "profileName": (c.get("profile") or {}).get("givenName") or c.get("profileName"),
            }
        )
    return out


@mcp.tool()
def list_groups() -> list[dict]:
    """List Signal groups the linked account is a member of (id, name, member count)."""
    result = RPC.call("listGroups", {"account": ACCOUNT})
    return [
        {
            "id": g.get("id"),
            "name": g.get("name"),
            "members": len(g.get("members") or []),
        }
        for g in (result if isinstance(result, list) else [])
    ]


@mcp.tool()
def send_message(message: str, recipient: str | None = None, group_id: str | None = None) -> dict:
    """Send a Signal message.

    Provide exactly one destination: `recipient` (an E.164 phone number like
    +4917012345678) for a direct message, or `group_id` (from list_groups) for a
    group. The message is sent from the user's own Signal account — only send
    what the user asked to send, and nothing else.
    """
    if bool(recipient) == bool(group_id):
        raise ValueError("Provide exactly one of `recipient` or `group_id`.")
    params: dict = {"account": ACCOUNT, "message": message}
    if recipient:
        params["recipient"] = [recipient]
    else:
        params["groupId"] = group_id
    result = RPC.call("send", params)
    return {"sent": True, "timestamp": result.get("timestamp")}


@mcp.tool()
def get_recent_messages(limit: int = 50, contact: str | None = None, group_id: str | None = None) -> list[dict]:
    """Read the most recent captured Signal messages, newest last.

    Optional filters: `contact` (E.164 number — matches sender or recipient of
    direct messages) or `group_id`. Note: Signal keeps no server-side history —
    this only sees messages captured since the MultiMCP Signal connector was
    first linked and running."""
    RPC.ensure()  # make sure a daemon is receiving before reporting emptiness
    msgs = _read_capture()
    if group_id:
        msgs = [m for m in msgs if m.get("groupId") == group_id]
    elif contact:
        msgs = [
            m
            for m in msgs
            if not m.get("groupId") and contact in (m.get("source"), m.get("recipient"))
        ]
    return msgs[-max(1, min(limit, 500)):]


@mcp.tool()
def search_messages(query: str, limit: int = 20) -> list[dict]:
    """Case-insensitive text search over captured Signal messages (sender names,
    numbers, and message text), newest last. Note: Signal keeps no server-side
    history — this only sees messages captured since the MultiMCP Signal
    connector was first linked and running."""
    RPC.ensure()
    q = query.lower()
    hits = [
        m
        for m in _read_capture()
        if q in (m.get("text") or "").lower()
        or q in (m.get("sourceName") or "").lower()
        or q in (m.get("source") or "")
    ]
    return hits[-max(1, min(limit, 200)):]


@mcp.tool()
def wait_for_message(timeout_seconds: int = 60) -> list[dict]:
    """Wait for the next incoming Signal message (up to `timeout_seconds`, max
    240) and return any that arrive. Returns [] on timeout. Useful after sending
    a question to wait for the reply."""
    RPC.ensure()
    before = len(_read_capture())
    deadline = time.monotonic() + max(1, min(timeout_seconds, 240))
    while time.monotonic() < deadline:
        with RPC.new_message:
            RPC.new_message.wait(timeout=min(5.0, max(0.1, deadline - time.monotonic())))
        msgs = _read_capture()
        if len(msgs) > before:
            return msgs[before:]
    return []


def main() -> None:
    missing = [
        name
        for name, val in (
            ("SIGNAL_ACCOUNT", ACCOUNT),
            ("SIGNAL_CLI_PATH", CLI_PATH),
            ("SIGNAL_CONFIG_DIR", CONFIG_DIR),
        )
        if not val
    ]
    if missing:
        # Fail loud and early: a half-configured server that answers tools with
        # confusing errors is worse than one that refuses to start.
        _log(f"missing required environment: {', '.join(missing)}")
        sys.exit(1)
    _log(f"starting (account {ACCOUNT}, daemon port {PORT})")
    mcp.run()


if __name__ == "__main__":
    main()
