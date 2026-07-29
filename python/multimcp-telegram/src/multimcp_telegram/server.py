"""MCP server exposing the user's own Telegram account to AI clients.

Thin JSON-RPC client over the shared daemon (daemon.py) — connect-first,
spawn-if-absent, exactly the multimcp-signal pattern. The daemon owns the
Telethon session; this process owns nothing but a socket, so any number of AI
clients can run concurrently.

Telegram stores history server-side, so unlike Signal there is no local capture
store: reads and searches are live and reach the user's full history.
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
PORT = int(os.environ.get("TELEGRAM_DAEMON_PORT", "7584"))
SESSION_DIR = os.environ.get("TELEGRAM_SESSION_DIR", "")
DAEMON_START_TIMEOUT_S = 60.0
RPC_TIMEOUT_S = 90.0


def _log(msg: str) -> None:
    print(f"[multimcp-telegram] {msg}", file=sys.stderr, flush=True)


def _try_connect(timeout: float = 2.0) -> socket.socket | None:
    try:
        s = socket.create_connection((HOST, PORT), timeout=timeout)
        s.settimeout(None)
        return s
    except OSError:
        return None


def _spawn_daemon() -> None:
    """Start the shared daemon detached (same venv — sys.executable -m).

    CREATE_BREAKAWAY_FROM_JOB with fallback, mirroring multimcp-signal: MCP
    clients job-object their servers and reap detached children otherwise.
    """
    log_path = Path(SESSION_DIR or ".") / "daemon.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # Use pythonw.exe (no console) so the background daemon never flashes a
    # terminal window — whether spawned from here (under `uv run` python.exe) or
    # directly by the tray app. The daemon needs no stdio, so windowless is fine.
    exe = sys.executable
    if os.name == "nt":
        cand = exe.replace("python.exe", "pythonw.exe")
        if os.path.exists(cand):
            exe = cand
    cmd = [exe, "-m", "multimcp_telegram.daemon"]
    if os.name == "nt":
        flags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NO_WINDOW
            | 0x01000000  # CREATE_BREAKAWAY_FROM_JOB
        )
    else:
        flags = 0
    with open(log_path, "ab") as log_file:
        try:
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log_file, stderr=log_file, creationflags=flags, close_fds=True)
        except OSError:
            subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=log_file, stderr=log_file, creationflags=flags & ~0x01000000, close_fds=True
            )
    _log(f"spawned telegram daemon on {HOST}:{PORT}")


class Rpc:
    def __init__(self) -> None:
        self._sock: socket.socket | None = None
        self._lock = threading.Lock()
        self._next_id = 1
        self._pending: dict[int, dict] = {}
        self._events: dict[int, threading.Event] = {}

    def ensure(self) -> None:
        with self._lock:
            if self._sock is not None:
                return
            sock = _try_connect()
            if sock is None:
                _spawn_daemon()
                deadline = time.monotonic() + DAEMON_START_TIMEOUT_S
                while time.monotonic() < deadline and sock is None:
                    time.sleep(1.0)
                    sock = _try_connect()
            if sock is None:
                raise RuntimeError(f"telegram daemon not reachable on {HOST}:{PORT} — see daemon.log in the session dir")
            self._sock = sock
            threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self) -> None:
        try:
            f = self._sock.makefile("r", encoding="utf-8", errors="replace")
            for line in f:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if "id" in obj and obj["id"] is not None:
                    with self._lock:
                        self._pending[obj["id"]] = obj
                        ev = self._events.get(obj["id"])
                    if ev:
                        ev.set()
        except OSError as e:
            _log(f"daemon connection lost: {e}")
        finally:
            with self._lock:
                self._sock = None
                for ev in self._events.values():
                    ev.set()

    def call(self, method: str, params: dict | None = None, _retried: bool = False) -> dict | list:
        self.ensure()
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            ev = threading.Event()
            self._events[rid] = ev
            sock = self._sock
        try:
            if sock is None:
                raise OSError("no daemon connection")
            sock.sendall((json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n").encode("utf-8"))
            if not ev.wait(RPC_TIMEOUT_S):
                raise RuntimeError(f"telegram daemon did not answer {method!r} within {RPC_TIMEOUT_S:.0f}s")
            with self._lock:
                resp = self._pending.pop(rid, None)
            if resp is None:
                raise OSError("connection lost mid-call")
        except OSError:
            if _retried:
                raise
            with self._lock:
                self._sock = None
            return self.call(method, params, _retried=True)
        finally:
            with self._lock:
                self._events.pop(rid, None)
        if "error" in resp:
            raise RuntimeError(f"telegram: {resp['error'].get('message')}")
        return resp.get("result")


RPC = Rpc()
mcp = MCPServer("MultiMCP Telegram")


@mcp.tool()
def whoami() -> dict:
    """The Telegram account this connector is signed in as."""
    return RPC.call("status", {})


@mcp.tool()
def list_chats(limit: int = 50) -> list[dict]:
    """List the user's Telegram chats (dialogs), most recently active first —
    direct chats, groups, and channels, with unread counts."""
    return RPC.call("list_dialogs", {"limit": limit})


@mcp.tool()
def get_messages(chat: str, limit: int = 50) -> list[dict]:
    """Read the most recent messages of one chat, oldest first.

    `chat` accepts a numeric chat id (from list_chats), an @username, or a
    display-name fragment. Telegram keeps full server-side history, so this
    reaches back as far as the chat itself does."""
    return RPC.call("get_messages", {"chat": chat, "limit": limit})


@mcp.tool()
def search_messages(query: str, chat: str | None = None, limit: int = 25) -> list[dict]:
    """Search messages by text — across all chats, or within one chat if given.
    Searches the user's full server-side history."""
    return RPC.call("search_messages", {"query": query, "chat": chat, "limit": limit})


@mcp.tool()
def send_message(chat: str, message: str) -> dict:
    """Send a Telegram message to a chat (id, @username, or name fragment).

    The message is sent from the user's own account — only send what the user
    asked to send, and nothing else."""
    return RPC.call("send_message", {"chat": chat, "message": message})


def main() -> None:
    missing = [
        n
        for n, v in (
            ("TELEGRAM_API_ID", os.environ.get("TELEGRAM_API_ID", "")),
            ("TELEGRAM_API_HASH", os.environ.get("TELEGRAM_API_HASH", "")),
            ("TELEGRAM_SESSION_DIR", SESSION_DIR),
        )
        if not v
    ]
    if missing:
        _log(f"missing required environment: {', '.join(missing)}")
        sys.exit(1)
    _log(f"starting (daemon port {PORT})")
    mcp.run()


if __name__ == "__main__":
    main()
