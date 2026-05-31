import React, { useState } from "react";

const api = window.api;

export default function CredentialsSetup({ creds, onSaved, editing }) {
  const [clientId, setClientId] = useState(creds?.clientId || "");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      if (!clientId.trim()) throw new Error("Client ID is required.");
      // If editing and leaving secret blank, keep the stored one.
      const res = await api.credentials.save(clientId, clientSecret || (editing ? "" : ""));
      if (!res.ok) throw new Error(res.error || "Save failed.");
      onSaved();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card setup">
      <h1 className="setup__title">{editing ? "Update credentials" : "Connect your Google OAuth client"}</h1>
      <p className="muted">
        Paste the OAuth <strong>Client ID</strong> and <strong>Client Secret</strong> from your
        Google Cloud project. The secret is stored in <strong>Windows Credential Manager</strong>,
        never in plaintext.
      </p>

      <label className="field">
        <span>Client ID</span>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="xxxxxxxx.apps.googleusercontent.com"
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>Client Secret {editing && <em className="muted">(leave blank to keep current)</em>}</span>
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="GOCSPX-…"
          spellCheck={false}
        />
      </label>

      {err && <div className="error">{err}</div>}

      <div className="setup__actions">
        <button className="btn btn--primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save securely"}
        </button>
      </div>

      <p className="muted small">
        Credentials dir (shared with Claude): <code>{creds?.credentialsDir}</code>
      </p>
    </section>
  );
}
