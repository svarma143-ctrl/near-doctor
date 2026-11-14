import os from "node:os";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * BEST-EFFORT removal of secrets and personal details from text before it is shared in a friction report.
 * It recognises common formats; it cannot recognise every secret. Always read a report before you post it.
 *
 * Known gaps: an unlabelled seed phrase (12 or 24 plain words) and secrets in formats not listed below are
 * NOT detected. Over-redaction is accepted: any 64 or 128 hex characters are hidden, which also hides some hashes.
 * Public data that is not secret-shaped (NEAR account ids, base58 transaction hashes) is kept.
 *
 * Every pattern uses bounded or linear matching so a large pasted log cannot make the redactor slow.
 */
export function redact(input, { home = os.homedir(), hostname = os.hostname() } = {}) {
  let t = String(input ?? "");
  if (home && home.length > 1) t = t.split(home).join("~");

  // Private key blocks (PEM, OpenSSH). An unterminated block (a truncated paste) is redacted to the end of the text.
  t = t.replace(
    /-----BEGIN [A-Z0-9 ]{0,30}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,30}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----",
  );
  // Credentials embedded in a URL: scheme://user:password@host
  t = t.replace(/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/:@]{1,100}):([^\s/@]{1,200})@/gi, "$1$2:[REDACTED]@");

  // NEAR-style prefixed keys, and bare base58 secret keys (about 88 characters).
  t = t.replace(/\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{40,}/g, "$1:[REDACTED]");
  t = t.replace(/\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/g, "[REDACTED]");

  // Must run before the key=value rule, which would otherwise swallow only the word "Bearer" / "Basic".
  t = t.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]");
  t = t.replace(/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/g, "Basic [REDACTED]");

  // key = value / "key": "value" where the NAME contains a secret-looking word (client_secret, clientSecret,
  // AWS_SECRET_ACCESS_KEY, NEAR_PRIVATE_KEY, npm_token, ...).
  t = t.replace(
    /(["']?[\w.-]{0,40}(?:secret|passw(?:or)?d|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|seed(?:[_-]?phrase)?|mnemonic|credential|authorization)[\w.-]{0,40}["']?\s*[:=]\s*)("[^"\n]{0,2000}"|'[^'\n]{0,2000}'|[^\s,}\n]{1,2000})/gi,
    "$1[REDACTED]",
  );

  // Well-known token formats.
  t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED]");
  t = t.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]");
  t = t.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  t = t.replace(/\bnpm_[A-Za-z0-9]{20,}/g, "[REDACTED]");
  t = t.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]");
  t = t.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]");
  t = t.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]");
  t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]");

  // base64 of 32 bytes (44 chars ending in '='), e.g. raw ed25519 seeds or keys.
  t = t.replace(/\b[A-Za-z0-9+/]{43}=/g, "[REDACTED]");
  // 32- or 64-byte keys written as hex, with or without 0x.
  t = t.replace(/\b(?:0x)?[0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?\b/g, "[REDACTED]");

  // Home directories that were not the current user's, and Windows profiles.
  t = t.replace(/\/Users\/[^/\s]+/g, "/Users/<user>");
  t = t.replace(/\/home\/[^/\s]+/g, "/home/<user>");
  t = t.replace(/([A-Za-z]:\\+Users\\+)[^\\\s]+/g, "$1<user>");
  // Bounded to RFC lengths (local part 64, label 63): an unbounded `[\w.+-]+@` rescans a long word run from every position.
  t = t.replace(/[\w.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g, "<email>");
  // This machine's hostname (after emails, so user@host is already gone).
  if (hostname && hostname.length >= 3) t = t.replace(new RegExp(escapeRe(hostname), "gi"), "<host>");
  return t;
}
