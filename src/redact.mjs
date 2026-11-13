import os from "node:os";

/**
 * Strip secrets and personal details from text before it is shared in a friction report.
 * Conservative: when in doubt, redact. Public data (account ids, tx hashes) is kept.
 */
export function redact(input, { home = os.homedir() } = {}) {
  let t = String(input ?? "");
  if (home && home.length > 1) t = t.split(home).join("~");

  // NEAR-style prefixed keys and long base58 key bodies.
  t = t.replace(/\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{40,}/g, "$1:[REDACTED]");
  // Must run before the key=value rule, which would otherwise swallow only the word "Bearer".
  t = t.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]");
  // key = value / "key": "value" for secret-looking names.
  t = t.replace(
    /("?(?:secret_?key|private_?key|seed(?:_?phrase)?|mnemonic|password|passwd|token|api_?key|authorization)"?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,}\n]+)/gi,
    "$1[REDACTED]",
  );
  t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED]");
  t = t.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]");
  t = t.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  // base64 of 32 bytes (44 chars ending in '='), e.g. raw ed25519 seeds or keys.
  t = t.replace(/\b[A-Za-z0-9+/]{43}=/g, "[REDACTED]");
  // Home directories that were not the current user's.
  t = t.replace(/\/Users\/[^/\s]+/g, "/Users/<user>");
  t = t.replace(/\/home\/[^/\s]+/g, "/home/<user>");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>");
  return t;
}
