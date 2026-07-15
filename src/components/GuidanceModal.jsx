import React, { useState } from "react";

const api = window.api;

// A diff-style preview of the guidance we'd add to a client's rules file, plus a
// copy box for the client (Claude Desktop) that has no file to write.
export default function GuidanceModal({ client, status, busy, onApply, onClose }) {
  const title =
    client === "codex" ? "Teach ChatGPT Codex to use MultiMCP" : "Teach Claude to use MultiMCP";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal guide-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <strong>{title}</strong>
          <div className="modal__head-actions">
            <button className="btn btn--small" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="guide-modal__body">
          <p className="muted small">
            This adds a short instruction so the AI reaches for <strong>MultiMCP</strong> for
            Gmail, Drive, and Calendar — and always picks the right account — instead of a
            built-in, single-account integration.
          </p>

          {(status?.targets || []).map((t) =>
            t.kind === "file" ? (
              <FileTarget key={t.key} target={t} busy={busy} onApply={() => onApply(t.key)} />
            ) : (
              <CopyTarget key={t.key} target={t} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function FileTarget({ target, busy, onApply }) {
  const alreadyOurs = target.present && target.method === "marker";
  const alreadyTheirs = target.present && target.method === "heuristic";

  return (
    <section className="guide-target">
      <div className="guide-target__head">
        <div>
          <div className="guide-target__title">{target.label}</div>
          {target.sub && <div className="muted small">{target.sub}</div>}
        </div>
        <button
          className={`btn btn--small ${target.present ? "btn--done" : "btn--primary"}`}
          onClick={onApply}
          disabled={busy}
        >
          {busy
            ? "Adding…"
            : alreadyOurs
              ? "✓ Added — update"
              : alreadyTheirs
                ? "✓ Already covered — add anyway"
                : target.exists
                  ? "Add to this file"
                  : "Create this file"}
        </button>
      </div>

      {alreadyTheirs && (
        <div className="notice small">
          This file already has equivalent MultiMCP rules (not written by this app), so the
          step counts as done. You can still add the standard block below if you'd like.
        </div>
      )}

      <Diff removed={alreadyOurs ? target.current : null} added={target.proposed} />
    </section>
  );
}

function CopyTarget({ target }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(target.text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section className="guide-target">
      <div className="guide-target__head">
        <div>
          <div className="guide-target__title">{target.label}</div>
          {target.sub && <div className="muted small">{target.sub}</div>}
        </div>
        <button className="btn btn--small btn--primary" onClick={copy}>
          {copied ? "✓ Copied" : "Copy text"}
        </button>
      </div>
      <pre className="guide-diff guide-diff--plain">{target.text}</pre>
    </section>
  );
}

// A minimal +/- diff view: optional removed block (red), then the added block (green).
function Diff({ removed, added }) {
  const line = (s, sign) => (
    <div key={sign + s.i} className={`guide-diff__line guide-diff__line--${sign}`}>
      <span className="guide-diff__sign">{sign === "add" ? "+" : "−"}</span>
      <span>{s.t || " "}</span>
    </div>
  );
  const split = (block) => (block || "").split("\n").map((t, i) => ({ t, i }));
  return (
    <pre className="guide-diff">
      {removed && split(removed).map((s) => line(s, "del"))}
      {split(added).map((s) => line(s, "add"))}
    </pre>
  );
}
