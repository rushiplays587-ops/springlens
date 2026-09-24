import { parseAllDocuments } from "yaml";
import {
  BackendRef,
  ClassInfo,
  ConfigFile,
  ConfigKeyUse,
  ConfigProperty,
  ConfigSummary,
  GatewayRoute,
} from "./model.js";
import { redactRouteArgs, redactText, redactValue, stripControls, truncate } from "./redact.js";

/**
 * Reads Spring Boot configuration files (application and bootstrap, .yml/.yaml/
 * .properties, multi-document YAML) into flat, already-redacted properties and a
 * summary of what an engineer inheriting the repo wants to know: name, port,
 * profiles, datasource, gateway routes, discovery and config-server settings.
 *
 * Nothing here evaluates anything: files are parsed as data, custom YAML tags
 * are not executed, alias expansion, depth, property count and file size are
 * capped, and a file that cannot be parsed is reported as such without
 * affecting the rest of the scan. Profiles are NOT merged or resolved: each
 * file/document is shown as written.
 */

export const MAX_CONFIG_FILE_BYTES = 256 * 1024;
export const MAX_CONFIG_PROPERTIES = 5000;
const MAX_DEPTH = 20;
const MAX_DOCUMENTS = 50;
const MAX_ALIASES = 100;
const MAX_LOGICAL_LINE = 64 * 1024;

const CONFIG_NAME = /^(application|bootstrap)(?:-(.+))?\.(ya?ml|properties)$/i;

export function isConfigFileName(name: string): boolean {
  return CONFIG_NAME.test(name);
}

interface RawProp {
  key: string;
  value: string;
}

// ---------- .properties ----------

function unescapeProperties(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "f":
        return "\f";
      default:
        return c;
    }
  });
}

/** Parses .properties text; Spring's `#---` line splits it into documents. */
export function parsePropertiesText(text: string): RawProp[][] {
  const documents: RawProp[][] = [[]];
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^[#!]---\s*$/.test(line)) {
      documents.push([]);
      continue;
    }
    const trimmed = line.replace(/^[ \t\f]+/, "");
    if (trimmed === "" || trimmed[0] === "#" || trimmed[0] === "!") continue;

    // A trailing odd number of backslashes continues the logical line on the next physical line.
    line = trimmed;
    while (line.length < MAX_LOGICAL_LINE && /(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, "");
    }

    let k = 0;
    let key = "";
    while (k < line.length) {
      const ch = line[k];
      if (ch === "\\" && k + 1 < line.length) {
        key += ch + line[k + 1];
        k += 2;
        continue;
      }
      if (ch === "=" || ch === ":" || ch === " " || ch === "\t" || ch === "\f") break;
      key += ch;
      k++;
    }
    while (k < line.length && /[ \t\f]/.test(line[k])) k++;
    if (k < line.length && (line[k] === "=" || line[k] === ":")) k++;
    while (k < line.length && /[ \t\f]/.test(line[k])) k++;
    documents[documents.length - 1].push({
      key: unescapeProperties(key),
      value: unescapeProperties(line.slice(k)),
    });
  }
  return documents;
}

// ---------- YAML ----------

function flatten(
  value: unknown,
  prefix: string,
  out: RawProp[],
  depth: number,
  state: { truncated: boolean }
): void {
  if (out.length >= MAX_CONFIG_PROPERTIES) {
    state.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) out.push({ key: prefix, value: "" });
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out, depth + 1, state));
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) out.push({ key: prefix, value: "" });
    for (const [k, v] of entries) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1, state);
    }
  } else if (prefix) {
    out.push({ key: prefix, value: value === null || value === undefined ? "" : String(value) });
  }
}

/** One line of a parser error, scrubbed: parser messages can quote file content, which may hold a secret. */
function safeError(message: string): string {
  return truncate(redactText(message.split(/\r?\n/)[0]), 160);
}

/** Each YAML document as flat properties. A document that fails to parse is skipped and its error returned. */
function parseYamlText(text: string): {
  docs: { props: RawProp[]; truncated: boolean }[];
  errors: string[];
  limitNote?: string;
} {
  const docs: { props: RawProp[]; truncated: boolean }[] = [];
  const errors: string[] = [];
  const parsed = parseAllDocuments(text, {
    merge: true,
    prettyErrors: false,
    version: "1.2",
    logLevel: "silent",
  });
  const list = Array.isArray(parsed) ? parsed : [parsed];

  for (const doc of list.slice(0, MAX_DOCUMENTS)) {
    if (doc.errors.length > 0) {
      errors.push(safeError(doc.errors[0].message));
      continue;
    }
    try {
      const js = doc.toJS({ maxAliasCount: MAX_ALIASES });
      const props: RawProp[] = [];
      const state = { truncated: false };
      flatten(js, "", props, 0, state);
      docs.push({ props, truncated: state.truncated });
    } catch (err) {
      errors.push(safeError((err as Error).message));
    }
  }
  const limitNote = list.length > MAX_DOCUMENTS ? `more than ${MAX_DOCUMENTS} YAML documents; the rest were ignored` : undefined;
  return { docs, errors, limitNote };
}

// ---------- summary ----------

const normKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

function kindFromJdbc(url: string): { kind: string; target: string } | null {
  const m = url.match(/^jdbc:([a-z0-9]+):(.*)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const rest = m[2];
  const afterAt = rest.includes("@") ? rest.slice(rest.lastIndexOf("@") + 1) : rest;
  const net = afterAt.replace(/^\/\//, "").match(/^(\[[^\]]+\]|[^/?;:]+)(?::(\d+))?/);
  if ((rest.startsWith("//") || rest.includes("@")) && net) return { kind, target: net[2] ? `${net[1]}:${net[2]}` : net[1] };
  // jdbc:h2:mem:testdb, jdbc:hsqldb:file:/path — no network host
  return { kind, target: rest.split(/[;?]/)[0] || "(unspecified)" };
}

const BACKEND_KEYS: { norm: string; kind: string; parse: (v: string) => string | null }[] = [
  { norm: "spring.r2dbc.url", kind: "r2dbc", parse: (v) => v.replace(/^r2dbc:/i, "") },
  { norm: "spring.data.mongodb.uri", kind: "mongodb", parse: (v) => v.replace(/^mongodb(\+srv)?:\/\//i, "") },
  { norm: "spring.data.redis.host", kind: "redis", parse: (v) => v },
  { norm: "spring.redis.host", kind: "redis", parse: (v) => v },
  { norm: "spring.kafka.bootstrapservers", kind: "kafka", parse: (v) => v },
  { norm: "spring.rabbitmq.host", kind: "rabbitmq", parse: (v) => v },
  { norm: "spring.elasticsearch.uris", kind: "elasticsearch", parse: (v) => v },
];

const ROUTE_KEY = /^spring\.cloud\.gateway\.(?:mvc\.|server\.(?:webflux|webmvc)\.)?routes\[(\d+)\]\.(.+)$/i;
const DEFAULT_FILTER_KEY = /^spring\.cloud\.gateway\.(?:mvc\.|server\.(?:webflux|webmvc)\.)?default-filters\[(\d+)\](?:\.(.+))?$/i;

/** "AddRequestHeader=X-Api-Key, value": redacts the arguments after a secret-looking header/parameter name. */
function redactShortcut(text: string): string {
  const eq = text.indexOf("=");
  if (eq <= 0) return text;
  const args = text.slice(eq + 1).split(",").map((a) => a.trim());
  return `${text.slice(0, eq)}=${redactRouteArgs(args).join(",")}`;
}

/** Turns `predicates[0]` (shortcut string) or `predicates[0].name` + `.args.x` (map form) into "Path=/x" or "Name(arg=value)" strings. */
function collectShortcutList(props: ConfigProperty[], listPath: string): string[] {
  const items = new Map<number, { direct?: string; name?: string; args: string[] }>();
  for (const p of props) {
    if (!p.key.startsWith(listPath + "[")) continue;
    const m = p.key.slice(listPath.length).match(/^\[(\d+)\](?:\.(.+))?$/);
    if (!m) continue;
    const idx = Number(m[1]);
    const item = items.get(idx) ?? { args: [] };
    if (m[2] === undefined) item.direct = p.value;
    else if (m[2] === "name") item.name = p.value;
    else if (m[2].startsWith("args.")) {
      const argName = m[2].slice("args.".length);
      item.args.push(/^_genkey_\d+$/.test(argName) ? p.value : `${argName}=${p.value}`);
    } else if (m[2].startsWith("args[")) item.args.push(p.value);
    items.set(idx, item);
  }
  return [...items.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, it]) => {
      if (it.direct !== undefined) return redactShortcut(it.direct);
      return it.name ? `${it.name}${it.args.length ? "(" + redactRouteArgs(it.args).join(", ") + ")" : ""}` : "";
    })
    .filter((s) => s !== "");
}

function extractRoutes(props: ConfigProperty[]): GatewayRoute[] {
  const byIndex = new Map<string, Map<number, ConfigProperty[]>>();
  const routes: { prefix: string; idx: number; props: ConfigProperty[] }[] = [];
  for (const p of props) {
    const m = p.key.match(ROUTE_KEY);
    if (!m) continue;
    const prefix = p.key.slice(0, p.key.indexOf("routes[")) + "routes";
    const idx = Number(m[1]);
    const perPrefix = byIndex.get(prefix) ?? new Map<number, ConfigProperty[]>();
    perPrefix.set(idx, [...(perPrefix.get(idx) ?? []), p]);
    byIndex.set(prefix, perPrefix);
  }
  for (const [prefix, perIdx] of byIndex) {
    for (const [idx, ps] of perIdx) routes.push({ prefix, idx, props: ps });
  }
  routes.sort((a, b) => a.prefix.localeCompare(b.prefix) || a.idx - b.idx);

  return routes.map(({ prefix, idx, props: ps }) => {
    const at = `${prefix}[${idx}]`;
    const get = (name: string) => ps.find((p) => p.key === `${at}.${name}`)?.value ?? "";
    return {
      id: get("id"),
      uri: get("uri"),
      predicates: collectShortcutList(ps, `${at}.predicates`),
      filters: collectShortcutList(ps, `${at}.filters`),
    };
  });
}

function summarize(props: ConfigProperty[]): ConfigSummary {
  const byNorm = new Map<string, ConfigProperty>();
  for (const p of props) if (!byNorm.has(normKey(p.key))) byNorm.set(normKey(p.key), p);
  const get = (key: string) => byNorm.get(normKey(key))?.value;
  const startsWith = (prefix: string) => props.filter((p) => normKey(p.key).startsWith(normKey(prefix)));

  const backends: BackendRef[] = [];
  for (const p of props) {
    if (/^spring\.datasource(?:\.[^.]+)*\.(?:jdbc-?url|url)$/i.test(p.key)) {
      const jdbc = kindFromJdbc(p.value);
      if (jdbc) backends.push({ ...jdbc, key: p.key });
      else if (p.value) backends.push({ kind: "datasource", target: p.value, key: p.key });
    }
  }
  for (const b of BACKEND_KEYS) {
    const p = byNorm.get(b.norm);
    if (p && p.value) {
      const target = b.parse(p.value);
      if (target) backends.push({ kind: b.kind, target, key: p.key });
    }
  }

  const profiles: { key: string; value: string }[] = [];
  for (const k of ["spring.profiles.active", "spring.profiles.default", "spring.profiles.include"]) {
    for (const p of startsWith(k)) {
      if (normKey(p.key) === normKey(k) || normKey(p.key).startsWith(normKey(k) + "[")) {
        profiles.push({ key: p.key, value: p.value });
      }
    }
  }

  const defaultFilterProps = props.filter((p) => DEFAULT_FILTER_KEY.test(p.key));
  const defaultFilters: string[] = [];
  const filterLists = new Set(
    defaultFilterProps.map((p) => p.key.slice(0, p.key.indexOf("default-filters") + "default-filters".length))
  );
  for (const list of filterLists) defaultFilters.push(...collectShortcutList(defaultFilterProps, list));

  const configImports = [
    ...startsWith("spring.config.import").map((p) => p.value),
    ...(get("spring.cloud.config.uri") ? [get("spring.cloud.config.uri") as string] : []),
  ].filter((v) => v !== "");

  const configServer = props
    .filter((p) => /^spring\.cloud\.config\.server\./i.test(p.key) && p.value !== "")
    .filter((p) => /(uri|searchlocations|defaultlabel|label)/i.test(normKey(p.key)))
    .map((p) => `${p.key.replace(/^spring\.cloud\.config\.server\./i, "")}: ${p.value}`);

  const groupCounts = new Map<string, number>();
  for (const p of props) {
    const segs = p.key.replace(/\[\d+\]/g, "").split(".");
    const name = segs[0] === "spring" && segs.length > 1 ? `spring.${segs[1]}` : segs[0];
    groupCounts.set(name, (groupCounts.get(name) ?? 0) + 1);
  }
  const groups = [...groupCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const locator =
    props.find((p) => /\.discovery\.locator\.enabled$/i.test(p.key) && /^spring\.cloud\.gateway\./i.test(p.key))?.value;

  return {
    applicationName: get("spring.application.name"),
    port: get("server.port") ?? get("server.http.port"),
    contextPath: get("server.servlet.context-path") ?? get("server.context-path"),
    profiles,
    backends,
    routes: extractRoutes(props),
    defaultFilters,
    discoveryLocator: locator,
    discovery: get("eureka.client.service-url.defaultZone"),
    configImports,
    configServer,
    groups,
  };
}

// ---------- files ----------

function toProperties(raw: RawProp[]): ConfigProperty[] {
  return raw.map(({ key: rawKey, value: rawValue }) => {
    const key = stripControls(rawKey);
    const safeKey = truncate(redactText(key), 200);
    const { value: v, redacted } = redactValue(key, stripControls(rawValue));
    return { key: safeKey, value: v, redacted };
  });
}

function documentProfile(props: ConfigProperty[]): string | null {
  const onProfile = props.find((p) => normKey(p.key) === normKey("spring.config.activate.on-profile"));
  if (onProfile) return onProfile.value;
  const legacy = props.find((p) => p.key === "spring.profiles");
  return legacy ? legacy.value : null;
}

/**
 * Parses one config file's text. Never throws: any failure is returned as
 * `error` on the file so the caller can list it as unparsable and go on.
 */
export function parseConfigFile(relPath: string, text: string): ConfigFile {
  const name = relPath.split("/").pop() ?? relPath;
  const m = name.match(CONFIG_NAME);
  const base: ConfigFile = {
    file: relPath,
    format: m && m[3].toLowerCase() === "properties" ? "properties" : "yaml",
    profile: m?.[2] ?? null,
    bootstrap: m ? m[1].toLowerCase() === "bootstrap" : false,
    documents: [],
  };

  if (Buffer.byteLength(text, "utf-8") > MAX_CONFIG_FILE_BYTES) {
    return { ...base, error: `skipped: larger than ${MAX_CONFIG_FILE_BYTES / 1024} KB` };
  }

  try {
    const rawDocs =
      base.format === "properties"
        ? parsePropertiesText(text).map((props) => ({ props, truncated: props.length > MAX_CONFIG_PROPERTIES }))
        : null;
    const yamlResult = rawDocs ? null : parseYamlText(text);
    const docs = rawDocs ?? yamlResult!.docs;

    for (const d of docs) {
      const properties = toProperties(d.props.slice(0, MAX_CONFIG_PROPERTIES));
      if (properties.length === 0) continue;
      base.documents.push({
        onProfile: documentProfile(properties),
        properties,
        summary: summarize(properties),
        truncated: d.truncated,
      });
    }
    if (yamlResult?.limitNote && yamlResult.errors.length === 0) base.error = yamlResult.limitNote;
    if (yamlResult && yamlResult.errors.length > 0) {
      base.error = `unparsable YAML (${yamlResult.errors[0]})${
        base.documents.length > 0 ? "; the documents that did parse are shown" : ""
      }`;
    }
  } catch (err) {
    base.documents = [];
    base.error = `unparsable (${safeError((err as Error).message)})`;
  }
  return base;
}

// ---------- binding to code ----------

const VALUE_PLACEHOLDER = /@Value\s*\(\s*"\$\{\s*([^}:"\s]+)\s*(:[^}"]*)?\}[^"]*"\s*\)/g;

/** @Value("${some.key:default}") placeholders in a class body. Only the key and whether it has a default are kept — never the default. */
export function extractValueKeys(rawBody: string): ConfigKeyUse[] {
  const seen = new Map<string, ConfigKeyUse>();
  for (const m of rawBody.matchAll(VALUE_PLACEHOLDER)) {
    if (!seen.has(m[1])) seen.set(m[1], { key: m[1], hasDefault: m[2] !== undefined });
  }
  return [...seen.values()];
}

/** @ConfigurationProperties("prefix"), (prefix = "prefix") or (value = "prefix") arguments. */
export function extractConfigPrefix(annotationArgs: string): string | undefined {
  const m = annotationArgs.match(/^\s*(?:(?:prefix|value)\s*=\s*)?"([^"]*)"/);
  return m ? m[1] : undefined;
}

/** True if any scanned config file defines `key` (relaxed: case, "-" and "_" ignored). */
export function isKeyDefined(configs: ConfigFile[], key: string): boolean {
  const want = normKey(key);
  return configs.some((c) =>
    c.documents.some((d) => d.properties.some((p) => normKey(p.key) === want || normKey(p.key).startsWith(want + ".") || normKey(p.key).startsWith(want + "[")))
  );
}

export function isPrefixDefined(configs: ConfigFile[], prefix: string): boolean {
  const want = normKey(prefix);
  return configs.some((c) =>
    c.documents.some((d) => d.properties.some((p) => normKey(p.key).startsWith(want + ".") || normKey(p.key) === want))
  );
}

/** Attaches @Value keys to every class. (The @ConfigurationProperties prefix is set by the parser.) */
export function bindClassConfig(classes: ClassInfo[]): void {
  for (const cls of classes) {
    const keys = extractValueKeys(cls.rawBody);
    if (keys.length > 0) cls.configKeys = keys;
  }
}
