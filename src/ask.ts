import { ClassInfo } from "./model.js";

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
  kind: 4,
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
};

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
    const bothNoise = NOISE.has(allWords[i]) && NOISE.has(allWords[i + 1]);
    if (!bothNoise && !NOISE.has(joined)) add(joined, JOINED_WEIGHT, `${allWords[i]} ${allWords[i + 1]}`);
  }
  for (const word of typed) {
    for (const entry of Object.hasOwn(SYNONYMS, word) ? SYNONYMS[word] : []) {
      const weak = entry.endsWith("~");
      add(weak ? entry.slice(0, -1) : entry, weak ? WEAK_SYNONYM_WEIGHT : SYNONYM_WEIGHT, word);
    }
  }
  return [...terms.values()];
}

interface IndexedClass {
  cls: ClassInfo;
  tf: Map<string, number>; // field-weighted term frequency
  length: number; // sum of the weighted term frequencies
}

export interface SearchIndex {
  docs: IndexedClass[];
  df: Map<string, number>;
  avgLength: number;
}

function addField(tf: Map<string, number>, text: string, weight: number): void {
  for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + weight);
}

export function buildIndex(classes: ClassInfo[]): SearchIndex {
  const docs: IndexedClass[] = classes.map((cls) => {
    const tf = new Map<string, number>();
    addField(tf, cls.name, FIELD_WEIGHTS.name);
    addField(tf, cls.kind, FIELD_WEIGHTS.kind);
    for (const a of cls.annotations) addField(tf, a, FIELD_WEIGHTS.annotation);
    for (const e of cls.endpoints) {
      addField(tf, `${e.httpMethod} ${e.path} ${e.methodName}`, FIELD_WEIGHTS.endpoint);
    }
    for (const d of cls.dependsOn) addField(tf, d, FIELD_WEIGHTS.dependsOn);
    addField(tf, cls.file, FIELD_WEIGHTS.file);
    addField(tf, cls.rawBody, FIELD_WEIGHTS.body);
    let length = 0;
    for (const v of tf.values()) length += v;
    return { cls, tf, length };
  });

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const terms = queryTerms(question);
  const n = index.docs.length;
  if (n === 0 || limit <= 0) return [];

  const named = (name: string) =>
    new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(question);

  const ranked: (RankedClass & { exact: boolean })[] = [];
  for (const doc of index.docs) {
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
    const exact = named(doc.cls.name);
    if (score > 0 || exact) ranked.push({ cls: doc.cls, score, matched, exact });
  }

  ranked.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.score - a.score ||
      a.cls.name.localeCompare(b.cls.name) ||
      a.cls.file.localeCompare(b.cls.file)
  );
  return ranked.slice(0, limit).map(({ cls, score, matched }) => ({ cls, score, matched }));
}

const MAX_LISTED = 8;

function listCapped(items: string[]): string {
  if (items.length <= MAX_LISTED) return items.join(", ");
  return `${items.slice(0, MAX_LISTED).join(", ")} (+${items.length - MAX_LISTED} more)`;
}

/** Plain-text answer for the default, fully local mode. Says plainly that no AI answer was generated. */
export function formatLocalAnswer(
  question: string,
  results: RankedClass[],
  allClasses: ClassInfo[],
  aiRequested = false
): string {
  const lines: string[] = [];
  lines.push(`Question: ${question}`);
  lines.push("");

  if (results.length === 0) {
    lines.push(
      `No classes matched (searched ${allClasses.length}). Try words that appear in the code: ` +
        "class names, method names, endpoint paths."
    );
  } else {
    lines.push(
      `Most relevant classes by keyword search (${results.length} of ${allClasses.length}). ` +
        "No AI answer was generated."
    );
    results.forEach((r, i) => {
      const { cls } = r;
      const usedBy = allClasses
        .filter((c) => c.name !== cls.name && c.dependsOn.includes(cls.name))
        .map((c) => c.name);
      lines.push("");
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
      if (r.matched.length > 0) lines.push(`   Matched: ${r.matched.join(", ")}`);
    });
  }

  lines.push("");
  lines.push(
    "This is keyword ranking, not understanding: it can miss a class that uses different words " +
      "than your question." +
      (aiRequested
        ? ""
        : " Pass --ai for a written answer (sends the top classes' source to Anthropic).")
  );
  return lines.join("\n");
}
