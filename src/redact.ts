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
  "password|passwd|passphrase|pass|pswd|psw|pwd|pw|secret|token|key|credential|private|auth|cert|salt|signature|sig|hmac|cookie|sessionid|jwt|dsn|pfx";
const SECRET_KEY = new RegExp(SECRET_WORDS, "i");

/** Normalises compatibility forms and drops zero-width characters, so "pass​word" and fullwidth letters are still caught. */
function foldKey(key: string): string {
  return key.normalize("NFKC").replace(/[​-‏⁠﻿­]/g, "");
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(foldKey(key));
}

/** Longest text the pattern passes will scan; longer values are cut first (redaction is quadratic on a single huge token). */
export const MAX_REDACT_INPUT = 4096;

// A bare environment placeholder with no default, e.g. ${DB_PASSWORD}, reveals nothing and is useful to read.
const BARE_PLACEHOLDER = /^\$\{[A-Za-z0-9_.\-]+\}$/;

// scheme://user:password@host — the user may be empty (redis://:pw@host) and the password may contain "@".
// The password may contain "/" too, unless it starts like a port followed by a path (http://host:8080/x@y).
const URL_USERINFO = /(?<![a-z0-9+.\-])([a-z][a-z0-9+.\-]*:\/\/)([^\s:@\/]*):(?!\d+(?:\/|$))([^\s]*)@/gi;
// scheme://token@host — a lone userinfo is often an access token (git over https); "git@" is only a user name.
const URL_LONE_USERINFO = /(?<![a-z0-9+.\-])([a-z][a-z0-9+.\-]*:\/\/)(?!git@)([^\s:@\/]+)@/gi;
// user:password@host:port with no scheme (Kafka/Redis host lists)
const BARE_USERINFO = /(^|[,\s=])([A-Za-z0-9._\-]+):([^\s,@\/]+)@(?=[A-Za-z0-9.\-]+:\d)/g;
// Slack incoming-webhook secrets live in the path
const SLACK_WEBHOOK = /(hooks\.slack\.com\/services\/)[A-Za-z0-9\/]+/gi;
// jdbc:oracle:thin:user/password@host
const JDBC_SLASH_CREDENTIALS = /(jdbc:[a-z0-9]+:[a-z0-9]+:)([^\s\/@:]+)\/([^\s@]+)@/gi;
// HTTP Authorization header values
const AUTH_SCHEME = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+\/=\-]{6,}/g;
// name=value, name: value, "name":"value", name="a b" — where the NAME contains a secret word.
const SECRET_PARAM = new RegExp(
  `(^|[?&;,\\s\\[(]|(?<!\\$)\\{)(["']?)([\\w.\\-]*(?:${SECRET_WORDS})[\\w.\\-]*)\\2\\s*[=:]\\s*(\\[redacted\\]|"[^"]*"|'[^']*'|[^&;,\\s}\\])"']*)`,
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
  return text.replace(/[A-Za-z0-9_\-]{32,}/g, (run) => {
    if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) return run;
    // A long all-lowercase hyphenated run is a service or artifact name, not a key.
    const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run);
    const hex = /^[0-9a-f]+$/i.test(run);
    return mixedCase || hex || !run.includes("-") ? REDACTED : run;
  });
}

/** Removes control characters (terminal escapes, forged line breaks) from text that will be printed. */
export function stripControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

/**
 * Scrubs the argument list of a gateway predicate or filter such as
 * AddRequestHeader=X-Api-Key, value. When the first argument (a header or
 * parameter name) or a `name=` argument looks secret, every other argument is
 * redacted: the value sits under an innocent key so key-based redaction cannot see it.
 */
export function redactRouteArgs(args: string[]): string[] {
  const nameArg = args.find((a) => /^name=/i.test(a));
  const nameValue = nameArg ? nameArg.replace(/^name=/i, "") : args[0] ?? "";
  if (!isSecretKey(nameValue)) return args;
  return args.map((a) => {
    if (a === nameArg || (!nameArg && a === args[0])) return a;
    const eq = a.indexOf("=");
    return eq > 0 && /^[A-Za-z_][\w-]*$/.test(a.slice(0, eq)) ? `${a.slice(0, eq)}=${REDACTED}` : REDACTED;
  });
}

/** Redacts secrets embedded in free text: URL credentials, secret query parameters, token shapes, placeholder defaults. */
export function redactText(input: string): string {
  const text = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) + "…" : input;
  let out = text.replace(PEM_BLOCK, REDACTED);
  out = out.replace(SLACK_WEBHOOK, `$1${REDACTED}`);
  out = out.replace(JDBC_SLASH_CREDENTIALS, `$1$2/${REDACTED}@`);
  out = out.replace(URL_USERINFO, `$1$2:${REDACTED}@`);
  out = out.replace(URL_LONE_USERINFO, `$1${REDACTED}@`);
  out = out.replace(BARE_USERINFO, `$1$2:${REDACTED}@`);
  out = out.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
  out = out.replace(SECRET_PARAM, `$1$2$3$2=${REDACTED}`);
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
