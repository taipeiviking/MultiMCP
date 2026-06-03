// Email <-> credential-filename mapping, shared by the accounts service and the
// backup/import service so both produce the EXACT filename workspace-mcp expects.
// Pure (no electron/fs deps) so it can be unit-tested headlessly.
//
// Mirrors workspace-mcp auth/credential_store.py LocalDirectoryCredentialStore:
//   filename = urllib.parse.quote(email, safe="@._-") + ".json"

// urllib.parse.quote never quotes unreserved chars (A-Z a-z 0-9 _ . - ~);
// workspace-mcp additionally marks @._- safe. Everything else is %XX (UTF-8).
function quoteEmail(email) {
  return Array.from(String(email))
    .map((ch) => {
      if (/[A-Za-z0-9_.\-~@]/.test(ch)) return ch;
      return Array.from(Buffer.from(ch, "utf8"))
        .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
        .join("");
    })
    .join("");
}

// Pre-URL-encoding legacy filename form (older workspace-mcp versions).
function legacySafeEmail(email) {
  return String(email).replace(/[^a-zA-Z0-9@._-]/g, "_");
}

function decodeStem(stem) {
  if (stem.includes("%")) {
    try {
      return decodeURIComponent(stem);
    } catch {
      return stem;
    }
  }
  return stem;
}

module.exports = { quoteEmail, legacySafeEmail, decodeStem };
