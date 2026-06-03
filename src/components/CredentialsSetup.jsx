import React, { useState } from "react";
import ImportSettings from "./ImportSettings.jsx";

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
      <h1 className="setup__title">
        {editing ? "Google OAuth client (shared by all accounts)" : "Connect your Google OAuth client"}
      </h1>
      <p className="muted">
        This is your project's <strong>one</strong> OAuth client — the same{" "}
        <strong>Client ID</strong> and <strong>Client Secret</strong> are used to sign in{" "}
        <strong>every</strong> account you add (it is <em>not</em> per-account). Paste them
        from your Google Cloud project; the secret is stored in{" "}
        <strong>Windows Credential Manager</strong>, never in plaintext. Each account's own
        token is created separately when you click <strong>Sign in</strong> / <strong>Re-auth</strong>.
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

      {!editing && (
        <div className="setup__import">
          <p className="muted small">
            Already set this up on another computer? Bring everything over —
            Client&nbsp;ID&nbsp;&amp;&nbsp;Secret, accounts, and sign-ins — from an
            exported file instead of typing it again:
          </p>
          <ImportSettings onImported={onSaved} label="Import settings from a file…" />
        </div>
      )}

      <p className="muted small">
        Credentials dir (shared with Claude): <code>{creds?.credentialsDir}</code>
      </p>
    </section>
  );
}
