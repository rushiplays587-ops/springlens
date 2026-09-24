/**
 * Secret redaction for configuration values. Config files hold passwords,
 * tokens and keys, and everything derived from them (the report, the HTML,
 * `ask` output, AI prompts) is built from values that went through here first,
 * so redaction happens once, at parse time, and downstream code never sees a
 * raw secret.
 *
 * This is pattern-based and errs toward over-redacting: a key whose name looks
 * secret loses its value entirely; other values lose URL credentials, secret-
 * looking query parameters and placeholder defaults, and anything shaped like
 * a well-known token. It cannot recognise an arbitrary secret stored under an
 * innocent-looking key with an innocent-looking value.
 */

export const REDACTED = "[redacted]";
export const MAX_VALUE_CHARS = 300;

// Any dotted segment containing one of these marks the whole key secret.
const SECRET_WORDS =
  "password|passwd|passphrase|pwd|secret|token|key|credential|private|auth|cert|salt|signature";
const SECRET_KEY = new RegExp(SECRET_WORDS, "i");

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

// A bare environment placeholder with no default, e.g. ${DB_PASSWORD}, reveals nothing and is useful to read.
const BARE_PLACEHOLDER = /^\$\{[A-Za-z0-9_.\-]+\}$/;

const URL_USERINFO = /([a-z][a-z0-9+.\-]*:\/\/)([^\s/:@]+):([^\s/@]*)@/gi;
const SECRET_PARAM = new RegExp(
  `(^|[?&;,\\s])([^=&;,\\s?]*(?:${SECRET_WORDS})[^=&;,\\s?]*)=([^&;,\\s]*)`,
  "gi"
);
const SECRET_PLACEHOLDER_DEFAULT = new RegExp(
  `\\$\\{([^}:]*(?:${SECRET_WORDS})[^}:]*):([^}]*)\\}`,
  "gi"
);
const PEM_BLOCK = /-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g;
const TOKEN_SHAPES: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_\-]{16,}\b/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9\-]{10,}\b/g, // Slack
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g, // OpenAI / Anthropic style
  /\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*\b/g, // JWT
];

/** A long run of letters and digits that mixes both is almost always a key or hash, not a class or path segment. */
function redactOpaqueTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_\-]{32,}/g, (run) =>
    /[A-Za-z]/.test(run) && /[0-9]/.test(run) ? REDACTED : run
  );
}

/** Redacts secrets embedded in free text: URL credentials, secret query parameters, token shapes, placeholder defaults. */
export function redactText(text: string): string {
  let out = text.replace(PEM_BLOCK, REDACTED);
  out = out.replace(URL_USERINFO, `$1$2:${REDACTED}@`);
  out = out.replace(SECRET_PARAM, `$1$2=${REDACTED}`);
  out = out.replace(SECRET_PLACEHOLDER_DEFAULT, `\${$1:${REDACTED}}`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return redactOpaqueTokens(out);
}

export function truncate(text: string, max = MAX_VALUE_CHARS): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * The value to keep for a config property: fully redacted under a secret-looking
 * key (except a bare ${ENV} placeholder), otherwise scrubbed of embedded secrets.
 * Truncated last, so a cut can never expose half of a secret that was not caught.
 */
export function redactValue(key: string, value: string): { value: string; redacted: boolean } {
  if (isSecretKey(key)) {
    if (value === "" || BARE_PLACEHOLDER.test(value.trim())) return { value, redacted: false };
    return { value: REDACTED, redacted: true };
  }
  const cleaned = redactText(value);
  return { value: truncate(cleaned), redacted: cleaned !== value };
}
