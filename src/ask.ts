import { ClassInfo, ConfigFile } from "./model.js";
import { stripControls } from "./redact.js";

/**
 * Local retrieval for "ask the codebase". Everything here is pure: no network,
 * no filesystem. It indexes the repo model (names, kinds, annotations,
 * endpoints, dependencies, source words) and ranks classes against a question
 * with BM25, so the default `ask` mode is useful with no AI at all.
 */

export const MAX_QUESTION_CHARS = 1000;
export const DEFAULT_RESULT_COUNT = 5;

// Field weights: a hit in a class's name or endpoint says far more about what
// it is for than the same word somewhere in its body.
const FIELD_WEIGHTS = {
  name: 6,
  kind: 6,
  endpoint: 4,
  annotation: 2,
  dependsOn: 1.5,
  file: 1,
  body: 1,
} as const;

const K1 = 1.2;
const B = 0.75;
const SYNONYM_WEIGHT = 0.4;
const WEAK_SYNONYM_WEIGHT = 0.15;
const JOINED_WEIGHT = 0.6;
// A word repeated in a class body counts at most this many times, so a class that merely
// mentions "ownerRepository" ten times cannot outrank the repository itself.
const BODY_TF_CAP = 3;
// Second words that form phrasal verbs ("log in", "sign up") and so are joined to the first.
const JOIN_PARTICLES = new Set(["in", "up", "out", "on", "off"]);

// Words that carry no signal: English question words plus Java/Spring syntax
// that appears in nearly every class body.
const NOISE = new Set(
  (
    "a an the is are was were be been do does did done how what which who whom whose where when why " +
    "of to in on at by for from with without and or not no it its this that these those there here " +
    "can could should would will shall may might must i we you they me my our your about any all " +
    "class classes code file files find show tell explain used use using talk talks work works " +
    "get set has have had if else then than so as into out up over " +
    "public private protected static final void return returns new null true false this super extends " +
    "implements import package throws throw try catch finally int long boolean string var " +
    "override java"
  ).split(" ")
);

// Query words expanded to related code vocabulary, at a lower weight than the
// words actually typed ("~" marks a weaker relation). Deliberately small and
// Spring-specific.
const SYNONYMS: Record<string, string[]> = {
  database: ["repository", "jpa", "jdbc", "sql", "entity~"],
  db: ["repository", "jpa", "jdbc", "sql", "entity~"],
  sql: ["repository", "jpa", "jdbc", "entity~"],
  persistence: ["repository", "jpa", "entity~"],
  persist: ["repository", "jpa", "entity~"],
  storage: ["repository", "entity~"],
  table: ["entity", "repository~"],
  endpoint: ["controller", "mapping"],
  api: ["controller", "mapping"],
  route: ["controller", "mapping"],
  rest: ["controller", "mapping"],
  http: ["controller", "mapping"],
  url: ["controller", "mapping"],
  config: ["configuration", "bean"],
  configuration: ["config", "bean"],
  setting: ["configuration", "config"],
  setup: ["configuration", "config"],
  logic: ["service"],
  business: ["service"],
  error: ["exception", "advice", "handler"],
  exception: ["advice", "handler"],
  failure: ["exception", "advice", "handler"],
  login: ["auth", "authenticate", "security", "password", "token"],
  auth: ["authenticate", "security", "login", "token"],
  authentication: ["auth", "security", "login", "token"],
  security: ["auth", "authenticate", "token"],
  password: ["auth", "login", "security"],
  store: ["repository", "entity~"],
  save: ["repository", "entity~"],
  saved: ["repository", "entity~"],
  fetch: ["repository~", "client"],
  load: ["repository~"],
  create: ["controller~", "post"],
  delete: ["controller~"],
  update: ["controller~", "put"],
};

// Looked up by stem so "stored"/"stores"/"store" all find the same entry.
const SYNONYMS_BY_STEM = new Map(Object.entries(SYNONYMS).map(([word, related]) => [stem(word), related]));

/** Reduces a lower-case word to a rough stem so "users"/"user" and "handled"/"handle" meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Splits camelCase, PascalCase, acronyms, snake_case, paths and digits into lower-case words. */
function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2 && !/^[0-9]+$/.test(w));
}

/** Lower-cased, noise-free, stemmed identifier/word tokens of a piece of text. */
export function tokenize(text: string): string[] {
  return splitWords(text)
    .filter((w) => !NOISE.has(w))
    .map(stem);
}

export interface QueryTerm {
  term: string; // stemmed
  weight: number;
  display: string; // the word to show the user when this term matched
}

/** Turns a question into weighted, de-duplicated query terms (typed words first, synonyms lighter). */
export function queryTerms(question: string): QueryTerm[] {
  const terms = new Map<string, QueryTerm>();
  const add = (word: string, weight: number, display: string) => {
    const term = stem(word);
    const existing = terms.get(term);
    if (!existing || existing.weight < weight) terms.set(term, { term, weight, display });
  };

  const allWords = splitWords(question);
  const typed = allWords.filter((w) => !NOISE.has(w));
  for (const word of typed) add(word, 1, word);
  // "log in" should also find "login": try each adjacent pair joined into one word.
  for (let i = 0; i + 1 < allWords.length; i++) {
    const joined = allWords[i] + allWords[i + 1];
    const joinable =
      !NOISE.has(allWords[i]) && (!NOISE.has(allWords[i + 1]) || JOIN_PARTICLES.has(allWords[i + 1]));
    if (joinable && !NOISE.has(joined)) add(joined, JOINED_WEIGHT, `${allWords[i]} ${allWords[i + 1]}`);
  }
  for (const word of typed) {
    for (const entry of SYNONYMS_BY_STEM.get(stem(word)) ?? []) {
      const weak = entry.endsWith("~");
      add(weak ? entry.slice(0, -1) : entry, weak ? WEAK_SYNONYM_WEIGHT : SYNONYM_WEIGHT, word);
    }
  }
  return [...terms.values()];
}

interface IndexedDoc {
  cls: ClassInfo | null; // exactly one of cls / config is set
  config: ConfigFile | null;
  tf: Map<string, number>; // field-weighted term frequency
  length: number; // sum of the weighted term frequencies
}

export interface SearchIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLength: number;
}

function addField(tf: Map<string, number>, text: string, weight: number, cap = Infinity): void {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) tf.set(token, (tf.get(token) ?? 0) + weight * Math.min(count, cap));
}

/** Config files are searched by their application name, summary words (port, routes, datasource...), keys and values. */
function indexConfig(cfg: ConfigFile): Map<string, number> {
  const tf = new Map<string, number>();
  const appNames = cfg.documents.map((d) => d.summary.applicationName ?? "").join(" ");
  addField(tf, appNames, FIELD_WEIGHTS.name);
  addField(tf, cfg.file, FIELD_WEIGHTS.file);
  addField(tf, "config configuration properties settings", FIELD_WEIGHTS.dependsOn);

  const summaryWords: string[] = [];
  for (const doc of cfg.documents) {
    const sum = doc.summary;
    if (sum.port) summaryWords.push("server port listens", sum.port);
    if (sum.contextPath) summaryWords.push("context path");
    if (sum.profiles.length > 0) summaryWords.push("profile profiles active");
    for (const b of sum.backends) summaryWords.push("database datasource", b.kind, b.target);
    if (sum.discovery) summaryWords.push("eureka discovery registry");
    if (sum.configImports.length > 0 || sum.configServer.length > 0) summaryWords.push("config server import");
    if (sum.routes.length > 0 || sum.defaultFilters.length > 0) summaryWords.push("gateway route routes routing routed");
    for (const r of sum.routes) summaryWords.push(r.id, r.uri, ...r.predicates, ...r.filters);
  }
  addField(tf, summaryWords.join(" "), FIELD_WEIGHTS.endpoint);

  for (const doc of cfg.documents) {
    for (const p of doc.properties) {
      addField(tf, p.key, FIELD_WEIGHTS.annotation);
      addField(tf, p.value, FIELD_WEIGHTS.body, BODY_TF_CAP);
    }
  }
  return tf;
}

export function buildIndex(classes: ClassInfo[], configs: ConfigFile[] = []): SearchIndex {
  const docs: IndexedDoc[] = classes.map((cls) => {
    const tf = new Map<string, number>();
    addField(tf, cls.name, FIELD_WEIGHTS.name);
    addField(tf, cls.kind, FIELD_WEIGHTS.kind);
    for (const a of cls.annotations) addField(tf, a, FIELD_WEIGHTS.annotation);
    for (const e of cls.endpoints) {
      addField(tf, `${e.httpMethod} ${e.path} ${e.methodName}`, FIELD_WEIGHTS.endpoint);
    }
    for (const d of cls.dependsOn) addField(tf, d, FIELD_WEIGHTS.dependsOn);
    addField(tf, cls.file, FIELD_WEIGHTS.file);
    addField(tf, cls.rawBody, FIELD_WEIGHTS.body, BODY_TF_CAP);
    if (cls.endpoints.length > 0) addField(tf, "endpoint", FIELD_WEIGHTS.endpoint);
    let length = 0;
    for (const v of tf.values()) length += v;
    return { cls, config: null, tf, length };
  });

  for (const config of configs) {
    if (config.documents.length === 0) continue;
    const tf = indexConfig(config);
    let length = 0;
    for (const v of tf.values()) length += v;
    docs.push({ cls: null, config, tf, length });
  }

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgLength = docs.length === 0 ? 0 : docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  return { docs, df, avgLength };
}

export interface RankedClass {
  cls: ClassInfo;
  score: number;
  matched: string[]; // words from the question (or related words) that hit this class
}

export type RankedItem =
  | { type: "class"; cls: ClassInfo; score: number; matched: string[] }
  | { type: "config"; config: ConfigFile; score: number; matched: string[] };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Scored {
  doc: IndexedDoc;
  score: number;
  matched: string[];
  exact: boolean;
}

function scoreDocs(index: SearchIndex, question: string, only: "class" | "all"): Scored[] {
  const terms = queryTerms(question);
  const n = index.docs.length;
  if (n === 0) return [];

  const named = (name: string) =>
    new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(question);

  const scored: Scored[] = [];
  for (const doc of index.docs) {
    if (only === "class" && !doc.cls) continue;
    let score = 0;
    const matched: string[] = [];
    for (const { term, weight, display } of terms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = index.avgLength === 0 ? 1 : 1 - B + (B * doc.length) / index.avgLength;
      score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
      if (!matched.includes(display)) matched.push(display);
    }
    const exact = doc.cls ? named(doc.cls.name) : false;
    if (score > 0 || exact) scored.push({ doc, score, matched, exact });
  }

  const label = (d: IndexedDoc) => (d.cls ? d.cls.name : "");
  const path = (d: IndexedDoc) => (d.cls ? d.cls.file : d.config!.file);
  scored.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.score - a.score ||
      label(a.doc).localeCompare(label(b.doc)) ||
      path(a.doc).localeCompare(path(b.doc))
  );
  return scored;
}

/**
 * Ranks classes against a question. A class whose exact name appears (same
 * case, so the plain word "order" does not pin a class called Order) in the
 * question comes first (someone asking about "UserService" wants UserService),
 * then everything else by BM25. Classes matching nothing are left out.
 */
export function rank(
  index: SearchIndex,
  question: string,
  limit = DEFAULT_RESULT_COUNT
): RankedClass[] {
  if (limit <= 0) return [];
  return scoreDocs(index, question, "class")
    .slice(0, limit)
    .map(({ doc, score, matched }) => ({ cls: doc.cls!, score, matched }));
}

/** Like rank(), but classes and config files compete in one list. */
export function rankAll(
  index: SearchIndex,
  question: string,
  limit = DEFAULT_RESULT_COUNT
): RankedItem[] {
  if (limit <= 0) return [];
  return scoreDocs(index, question, "all")
    .slice(0, limit)
    .map(({ doc, score, matched }): RankedItem =>
      doc.cls
        ? { type: "class", cls: doc.cls, score, matched }
        : { type: "config", config: doc.config!, score, matched }
    );
}

const MAX_LISTED = 8;

function listCapped(items: string[]): string {
  if (items.length <= MAX_LISTED) return items.join(", ");
  return `${items.slice(0, MAX_LISTED).join(", ")} (+${items.length - MAX_LISTED} more)`;
}

const MAX_SETTING_LINES = 6;

/** Lines about one config file for the local answer. Values were redacted when the file was parsed. */
function configLines(question: string, config: ConfigFile): string[] {
  const lines: string[] = [];
  const terms = new Set(queryTerms(question).map((t) => t.term));
  const summaries = config.documents.map((d) => d.summary);
  const first = summaries.find((s) => s.applicationName);
  if (first?.applicationName) lines.push(`   Application: ${first.applicationName}`);

  config.documents.forEach((doc, i) => {
    const sum = doc.summary;
    const where = doc.onProfile ? ` [profile ${doc.onProfile}]` : config.documents.length > 1 ? ` [document ${i + 1}]` : "";
    if (sum.port) lines.push(`   Port${where}: ${sum.port}`);
    if (sum.contextPath) lines.push(`   Context path${where}: ${sum.contextPath}`);
    for (const b of sum.backends) lines.push(`   Data source${where}: ${b.kind} at ${b.target}`);
    if (sum.discovery) lines.push(`   Eureka${where}: ${sum.discovery}`);
    for (const c of sum.configImports) lines.push(`   Config import${where}: ${c}`);
    if (sum.routes.length > 0) {
      lines.push(`   Gateway routes${where}:`);
      for (const r of sum.routes.slice(0, 12)) {
        const bits = [...r.predicates, ...r.filters.map((f) => `filter ${f}`)].join(", ");
        lines.push(`     ${r.id || "(no id)"} -> ${r.uri || "(no uri)"}${bits ? ` [${bits}]` : ""}`);
      }
      if (sum.routes.length > 12) lines.push(`     (+${sum.routes.length - 12} more routes)`);
    }
    if (sum.defaultFilters.length > 0) lines.push(`   Default filters${where}: ${sum.defaultFilters.join(", ")}`);
  });

  const settings: string[] = [];
  for (const doc of config.documents) {
    for (const p of doc.properties) {
      if (settings.length >= MAX_SETTING_LINES) break;
      if (tokenize(p.key).some((t) => terms.has(t))) settings.push(`   ${p.key} = ${p.value === "" ? '""' : p.value}`);
    }
  }
  if (settings.length > 0) {
    lines.push("   Matching settings:");
    lines.push(...settings.map((l) => "  " + l));
  }
  return lines;
}

/**
 * Plain-text answer for the default, fully local mode: the best-matching
 * classes and config files. Says plainly that no AI answer was generated.
 */
export function formatAnswer(
  question: string,
  results: RankedItem[],
  allClasses: ClassInfo[],
  aiRequested = false,
  configCount = 0
): string {
  const lines: string[] = [];
  lines.push(`Question: ${question}`);
  lines.push("");

  const searched =
    configCount > 0 ? `${allClasses.length} classes and ${configCount} config files` : `${allClasses.length}`;
  if (results.length === 0) {
    lines.push(
      `Nothing matched (searched ${searched}). Try words that appear in the code: ` +
        "class names, method names, endpoint paths, config keys."
    );
  } else {
    lines.push(
      `Most relevant results by keyword search (${results.length}; searched ${searched}). ` +
        "No AI answer was generated."
    );
    results.forEach((r, i) => {
      lines.push("");
      if (r.type === "config") {
        lines.push(`${i + 1}. ${r.config.file} (config file)`);
        lines.push(...configLines(question, r.config));
        if (r.matched.length > 0) lines.push(`   Matched: ${r.matched.join(", ")}`);
        return;
      }
      const { cls } = r;
      const usedBy = allClasses
        .filter((c) => c.name !== cls.name && c.dependsOn.includes(cls.name))
        .map((c) => c.name);
      lines.push(`${i + 1}. ${cls.name} (${cls.kind}) — ${cls.file}`);
      if (cls.endpoints.length > 0) {
        lines.push(
          "   Endpoints: " +
            listCapped(
              cls.endpoints.map((e) => `${e.httpMethod} ${e.path || "(no static path)"} -> ${e.methodName}()`)
            )
        );
      }
      lines.push(`   Depends on: ${cls.dependsOn.length ? listCapped(cls.dependsOn) : "(nothing else in this repo)"}`);
      lines.push(`   Used by: ${usedBy.length ? listCapped(usedBy) : "(no other class in this repo)"}`);
      if (cls.configPrefix !== undefined) lines.push(`   Binds config prefix: ${cls.configPrefix}`);
      if ((cls.configKeys?.length ?? 0) > 0) lines.push(`   Reads config: ${listCapped(cls.configKeys!.map((k) => k.key))}`);
      if (r.matched.length > 0) lines.push(`   Matched: ${r.matched.join(", ")}`);
    });
  }

  lines.push("");
  lines.push(
    "This is keyword ranking, not understanding: it can miss a class that uses different words " +
      "than your question. Config values under secret-looking keys are redacted." +
      (aiRequested
        ? ""
        : " Pass --ai for a written answer (sends the top classes' source and config lines to Anthropic).")
  );
  // File names and config text come from the repo: keep terminal escapes and forged line breaks out of the output.
  return lines.map(stripControls).join("\n");
}

/** Class-only convenience wrapper around formatAnswer. */
export function formatLocalAnswer(
  question: string,
  results: RankedClass[],
  allClasses: ClassInfo[],
  aiRequested = false
): string {
  return formatAnswer(
    question,
    results.map((r): RankedItem => ({ type: "class", ...r })),
    allClasses,
    aiRequested
  );
}
