import React, { useState } from "react";

const api = window.api;

// Self-contained "Import settings…" control: a button that opens the native file
// picker, previews the backup, confirms, imports, and reports the result.
// Reused on BOTH the first-run credentials screen and the dashboard, so a fresh
// install can import a setup before any Client ID/Secret has been entered.
//
// Props:
//   onImported  — called after a successful import (parent should re-read state).
//   label       — button text (default "Import settings…").
//   variant     — extra button class (e.g. "btn--primary").
export default function ImportSettings({ onImported, label = "Import settings…", variant = "" }) {
  const [preview, setPreview] = useState(null); // { path, appVersion, exportedAt, counts }
  const [msg, setMsg] = useState(null); // { kind, text }
  const [busy, setBusy] = useState(false);

  async function pick() {
    setMsg(null);
    const r = await api.backup?.pick();
    if (r?.ok) setPreview(r);
    else if (!r?.canceled) setMsg({ kind: "err", text: r?.error || "Could not read that file." });
  }

  async function confirm(overwrite) {
    const path = preview?.path;
    setPreview(null);
    if (!path) return;
    setBusy(true);
    const r = await api.backup?.import(path, overwrite);
    setBusy(false);
    if (r?.ok) {
      setMsg({
        kind: "ok",
        text: `Imported: ${r.accountsAdded} new account(s), ${r.credentialFilesWritten} sign-in(s) written${r.credentialFilesSkipped ? `, ${r.credentialFilesSkipped} skipped (already present)` : ""}${r.secretRestored ? ", client secret restored" : ""}.`,
      });
      onImported && onImported(r);
    } else {
      setMsg({ kind: "err", text: "Import failed: " + (r?.error || "unknown error") });
    }
  }

  return (
    <>
      <button className={`btn btn--small ${variant}`} onClick={pick} disabled={busy}>
        {busy ? "Importing…" : label}
      </button>

      {msg && (
        <p className={`small ${msg.kind === "err" ? "backup-msg--err" : "backup-msg--ok"}`}>
          {msg.text}
        </p>
      )}

      {preview && (
        <ImportConfirm
          info={preview}
          onCancel={() => setPreview(null)}
          onConfirm={confirm}
        />
      )}
    </>
  );
}

function ImportConfirm({ info, onCancel, onConfirm }) {
  const c = info.counts || {};
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <strong>Import settings</strong>
        </div>
        <div className="import-body small">
          <p className="muted">
            This file was exported
            {info.appVersion ? ` by app v${info.appVersion}` : ""}
            {info.exportedAt ? ` on ${new Date(info.exportedAt).toLocaleString()}` : ""}.
          </p>
          <ul>
            <li>{c.accounts || 0} account(s)</li>
            <li>{c.credentialFiles || 0} saved sign-in(s) (refresh tokens)</li>
            <li>{c.hasSecret ? "Includes" : "Does not include"} the OAuth Client ID &amp; secret</li>
          </ul>
          <p className="muted">
            Existing sign-ins on this computer are kept unless you choose to overwrite.
          </p>
        </div>
        <div className="modal__foot import-actions">
          <button className="btn btn--small" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn--small"
            onClick={() => onConfirm(true)}
            title="Replace existing token files from the backup"
          >
            Import &amp; overwrite
          </button>
          <button className="btn btn--primary btn--small" onClick={() => onConfirm(false)}>
            Import (keep existing)
          </button>
        </div>
      </div>
    </div>
  );
}
