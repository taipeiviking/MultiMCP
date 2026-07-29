"""The ONE process that owns the Telethon session.

Why a daemon at all: a Telethon session is a SQLite file bound to an MTProto
auth key — two processes using it concurrently corrupt the session (Telegram
kicks duplicated auth keys). Same single-writer constraint signal-cli has, same
cure: one shared daemon on a pinned localhost port (7584), everything else — the
MCP servers each AI client spawns, and the tray app's login flow — is a thin
JSON-RPC client that connects first and spawns this only if nothing answers.

Unlike Signal there is NO capture store: Telegram keeps full history server-side,
so reads/searches are answered live from the API.

Protocol: newline-delimited JSON-RPC 2.0 over TCP, loopback only.

Environment:
  TELEGRAM_API_ID / TELEGRAM_API_HASH  the user's own my.telegram.org app pair
  TELEGRAM_SESSION_DIR                 shared state dir (session + daemon log)
  TELEGRAM_DAEMON_PORT                 pinned port, default 7584
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path

from telethon import TelegramClient, errors, utils

HOST = "127.0.0.1"

API_ID = os.environ.get("TELEGRAM_API_ID", "")
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")
SESSION_DIR = os.environ.get("TELEGRAM_SESSION_DIR", "")
PORT = int(os.environ.get("TELEGRAM_DAEMON_PORT", "7584"))


def _log(msg: str) -> None:
    print(f"[multimcp-telegram-daemon] {msg}", file=sys.stderr, flush=True)


class Daemon:
    def __init__(self) -> None:
        Path(SESSION_DIR).mkdir(parents=True, exist_ok=True)
        session = str(Path(SESSION_DIR) / "multimcp")
        try:
            self.client = TelegramClient(session, int(API_ID), API_HASH)
        except sqlite3.OperationalError:
            # A half-written session (e.g. from an earlier double-spawn) can be
            # unopenable. It holds no login yet if we're here at startup, so
            # discard it and start clean rather than crash.
            for suffix in ("", "-journal", "-wal", "-shm"):
                try:
                    os.remove(session + ".session" + suffix)
                except OSError:
                    pass
            self.client = TelegramClient(session, int(API_ID), API_HASH)
        # Login flow state (start_login -> submit_code -> maybe submit_password).
        self._phone: str | None = None
        self._code_hash: str | None = None

    # -- helpers ------------------------------------------------------------

    async def _entity(self, chat):
        """Resolve a chat argument: numeric id, @username, or display-name search."""
        try:
            return await self.client.get_entity(int(chat))
        except (ValueError, TypeError):
            pass
        try:
            return await self.client.get_entity(chat)
        except (ValueError, errors.RPCError):
            pass
        # Last resort: match against dialog titles, case-insensitive substring.
        needle = str(chat).lower()
        async for d in self.client.iter_dialogs(limit=300):
            if needle in (d.name or "").lower():
                return d.entity
        raise ValueError(f"No chat found matching {chat!r}")

    @staticmethod
    def _msg_dict(m, chat_name=None) -> dict:
        sender = getattr(m, "sender", None)
        return {
            "id": m.id,
            "timestamp": int(m.date.timestamp() * 1000) if m.date else None,
            "direction": "out" if m.out else "in",
            "senderName": utils.get_display_name(sender) if sender else None,
            "chat": chat_name,
            "text": m.message or None,
            "hasMedia": bool(m.media),
        }

    # -- RPC methods --------------------------------------------------------

    async def rpc_status(self, _p):
        authorized = await self.client.is_user_authorized()
        me = await self.client.get_me() if authorized else None
        return {
            "authorized": authorized,
            "user": {
                "phone": f"+{me.phone}" if me and me.phone else None,
                "username": me.username if me else None,
                "name": utils.get_display_name(me) if me else None,
            }
            if me
            else None,
        }

    async def rpc_start_login(self, p):
        self._phone = p["phone"]
        sent = await self.client.send_code_request(self._phone)
        self._code_hash = sent.phone_code_hash
        return {"codeSent": True}

    async def rpc_submit_code(self, p):
        try:
            await self.client.sign_in(self._phone, p["code"], phone_code_hash=self._code_hash)
            return {"authorized": True}
        except errors.SessionPasswordNeededError:
            return {"authorized": False, "needPassword": True}

    async def rpc_submit_password(self, p):
        await self.client.sign_in(password=p["password"])
        return {"authorized": True}

    async def rpc_logout(self, _p):
        await self.client.log_out()
        return {"ok": True}

    async def rpc_list_dialogs(self, p):
        out = []
        async for d in self.client.iter_dialogs(limit=min(int(p.get("limit", 50)), 300)):
            out.append(
                {
                    "id": d.id,
                    "name": d.name,
                    "type": "channel" if d.is_channel else "group" if d.is_group else "user",
                    "unread": d.unread_count,
                    "lastMessageAt": int(d.date.timestamp() * 1000) if d.date else None,
                }
            )
        return out

    async def rpc_get_messages(self, p):
        entity = await self._entity(p["chat"])
        name = utils.get_display_name(entity)
        msgs = await self.client.get_messages(entity, limit=min(int(p.get("limit", 50)), 500))
        return [self._msg_dict(m, name) for m in reversed(msgs)]

    async def rpc_search_messages(self, p):
        limit = min(int(p.get("limit", 25)), 200)
        out = []
        if p.get("chat"):
            entity = await self._entity(p["chat"])
            name = utils.get_display_name(entity)
            async for m in self.client.iter_messages(entity, search=p["query"], limit=limit):
                out.append(self._msg_dict(m, name))
        else:
            async for m in self.client.iter_messages(None, search=p["query"], limit=limit):
                chat = await m.get_chat()
                out.append(self._msg_dict(m, utils.get_display_name(chat) if chat else None))
        out.reverse()
        return out

    async def rpc_send_message(self, p):
        entity = await self._entity(p["chat"])
        m = await self.client.send_message(entity, p["message"])
        return {"sent": True, "id": m.id, "chat": utils.get_display_name(entity)}

    # -- wire ---------------------------------------------------------------

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        peer = writer.get_extra_info("peername")
        _log(f"client connected: {peer}")
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    req = json.loads(line)
                except ValueError:
                    continue
                rid = req.get("id")
                method = req.get("method", "")
                handler = getattr(self, f"rpc_{method}", None)
                if handler is None:
                    resp = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}}
                else:
                    try:
                        result = await handler(req.get("params") or {})
                        resp = {"jsonrpc": "2.0", "id": rid, "result": result}
                    except Exception as e:  # surfaced to the caller, never fatal here
                        resp = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(e)}}
                writer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
                await writer.drain()
        except (ConnectionResetError, asyncio.IncompleteReadError):
            pass
        finally:
            _log(f"client disconnected: {peer}")
            try:
                writer.close()
            except Exception:
                pass

    async def run(self):
        await self.client.connect()
        _log(f"connected to Telegram (authorized: {await self.client.is_user_authorized()})")
        server = await asyncio.start_server(self.handle_client, HOST, PORT)
        _log(f"listening on {HOST}:{PORT}")
        async with server:
            await server.serve_forever()


def main() -> None:
    missing = [n for n, v in (("TELEGRAM_API_ID", API_ID), ("TELEGRAM_API_HASH", API_HASH), ("TELEGRAM_SESSION_DIR", SESSION_DIR)) if not v]
    if missing:
        _log(f"missing required environment: {', '.join(missing)}")
        sys.exit(1)
    # Fail clearly on a malformed api_id instead of a cryptic struct.error deep
    # in Telethon (a bad credential capture must never look like an engine bug).
    try:
        if not (0 < int(API_ID) < 2147483648):
            raise ValueError
    except ValueError:
        _log(f"TELEGRAM_API_ID is not a valid Telegram api_id: {API_ID!r} — re-run credential setup")
        sys.exit(1)
    try:
        asyncio.run(Daemon().run())
    except OSError as e:
        # Port taken = another daemon won the race; that daemon serves everyone.
        _log(f"not starting (port {PORT} busy?): {e}")
        sys.exit(0)


if __name__ == "__main__":
    main()
