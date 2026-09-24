import { ClassInfo, ClassKind, Endpoint } from "./model.js";
import { extractConfigPrefix } from "./config.js";

/**
 * v1 extraction strategy: annotation-driven heuristics, not a full Java AST parse.
 *
 * Spring's structure is almost entirely expressed through annotations
 * (@RestController, @Service, @Autowired, @GetMapping, ...), which are
 * regular, predictable tokens — so a careful text-based scan gets correct
 * results for the common cases without the complexity of a real parser.
 *
 * Two views of each file are kept in lockstep (same length, same indexes):
 *  - the "stripped" text: comments blanked, string literals intact, so real
 *    annotation values like @GetMapping("/users") can be read;
 *  - the "masked" text: additionally, the inside of every string/char
 *    literal is blanked. All structural scanning (braces, parens, annotation
 *    names) runs on the masked text, so a "}" or "@GetMapping(...)" inside a
 *    string can never be mistaken for code; values are then read from the
 *    stripped text at the same indexes.
 *
 * Known v1 limitations (documented, not oversights): Kotlin/Groovy sources are
 * not parsed, and a record is only picked up when it carries a Spring role
 * annotation (its components are not followed as dependencies); nested annotated classes are reported as their own
 * entries (their text also remains inside the enclosing class body); classes
 * sharing a simple name across packages are merged by name; @Bean-method
 * parameter injection is not followed. Upgrading to a real AST parser (e.g.
 * java-parser) is a reasonable future sprint if this stops being accurate
 * enough in practice.
 */

const KIND_BY_ANNOTATION: Record<string, ClassKind> = {
  RestController: "controller",
  Controller: "controller",
  ControllerAdvice: "advice",
  RestControllerAdvice: "advice",
  Service: "service",
  Repository: "repository",
  Entity: "entity",
  MappedSuperclass: "entity",
  Embeddable: "entity",
  Configuration: "configuration",
  SpringBootApplication: "configuration",
  Component: "component",
  Aspect: "component",
  ConfigurationProperties: "configuration",
};

const SPRING_DATA_REPOSITORY_TYPES = new Set([
  "Repository",
  "CrudRepository",
  "ListCrudRepository",
  "PagingAndSortingRepository",
  "ListPagingAndSortingRepository",
  "JpaRepository",
  "MongoRepository",
  "ReactiveCrudRepository",
  "ReactiveMongoRepository",
  "R2dbcRepository",
  "ElasticsearchRepository",
  "JpaSpecificationExecutor",
]);

const MAPPING_ANNOTATIONS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: "ANY",
};

// Common JDK / java.* / generic collection types we never want to report as
// "dependencies" even if they appear as a constructor param or field type.
const IGNORED_TYPE_NAMES = new Set([
  "String",
  "int",
  "long",
  "double",
  "float",
  "boolean",
  "char",
  "byte",
  "short",
  "void",
  "Integer",
  "Long",
  "Double",
  "Float",
  "Boolean",
  "Character",
  "Byte",
  "Short",
  "Object",
  "List",
  "Map",
  "Set",
  "Optional",
  "Collection",
  "ArrayList",
  "HashMap",
  "HashSet",
  "Logger",
  "extends",
  "super",
  "final",
]);

const MODIFIER_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "final",
  "abstract",
  "strictfp",
]);

/**
 * Blanks out comments (preserving line breaks, so later line/position
 * reasoning stays roughly aligned) so annotation-shaped text inside a
 * comment can't false-positive as real code. String/char literals are
 * passed through verbatim — deliberately not blanked here, because we need
 * the actual quoted path values inside annotations like @GetMapping("/users")
 * to survive. The scanner still tracks string/char/text-block boundaries so
 * a "//" or "/*" that happens to appear inside a literal isn't mistaken for
 * the start of a real comment.
 */
export function stripComments(source: string): string {
  let result = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      result += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        result += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        result += "  ";
        i += 2;
      }
      continue;
    }

    if (c === '"' && source.startsWith('"""', i)) {
      result += '"""';
      i += 3;
      while (i < n && !source.startsWith('"""', i)) {
        if (source[i] === "\\") {
          result += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        result += source[i];
        i++;
      }
      if (i < n) {
        result += '"""';
        i += 3;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      result += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") {
          result += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        result += source[i];
        i++;
      }
      if (i < n) {
        result += source[i];
        i++;
      }
      continue;
    }

    result += c;
    i++;
  }

  return result;
}

/**
 * Returns text of identical length in which the inside of every string,
 * char and text-block literal is replaced by spaces (newlines kept), so
 * structural scanning can't be fooled by braces, parens or annotation-shaped
 * text inside a literal.
 */
export function maskStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];

    if (c === '"' && src.startsWith('"""', i)) {
      out.push('"""');
      i += 3;
      while (i < n && !src.startsWith('"""', i)) {
        if (src[i] === "\\") {
          out.push(" ");
          i++;
          if (i < n) {
            out.push(src[i] === "\n" ? "\n" : " ");
            i++;
          }
          continue;
        }
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push('"""');
        i += 3;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          out.push(" ");
          i++;
          if (i < n && src[i] !== "\n") {
            out.push(" ");
            i++;
          }
          continue;
        }
        out.push(" ");
        i++;
      }
      if (i < n && src[i] === c) {
        out.push(c);
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join("");
}

/** Finds the index just past the matching ')' for a '(' at openParenIndex (masked text). */
function findMatchingParen(src: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Finds the index just past the matching '}' for a '{' at openBraceIndex (masked text). */
function findMatchingBrace(src: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

interface RawAnnotation {
  name: string;
  args: string; // raw text between the parens (string values intact), "" if no parens
  start: number;
  end: number;
}

/** Reads the identifier ending at (and not including) `end`. */
function wordEndingAt(src: string, end: number): { word: string; start: number } {
  let k = end;
  while (k > 0 && /[A-Za-z0-9_]/.test(src[k - 1])) k--;
  return { word: src.slice(k, end), start: k };
}

/**
 * Scans backwards from `beforeIndex` collecting the contiguous run of
 * annotations immediately preceding it (skipping whitespace between them).
 * Structure is read from `masked`; annotation argument text from `orig`.
 */
function collectAnnotationsBefore(
  masked: string,
  orig: string,
  beforeIndex: number
): RawAnnotation[] {
  const annotations: RawAnnotation[] = [];
  let cursor = beforeIndex;

  // Modifiers (public, final, ...) sit between the annotations and the
  // class/method keyword — skip over any of them first so the annotation
  // scan below isn't fooled into stopping at "public" and giving up.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (cursor > 0 && /\s/.test(masked[cursor - 1])) cursor--;
    const { word, start } = wordEndingAt(masked, cursor);
    if (word && MODIFIER_KEYWORDS.has(word)) {
      cursor = start;
      continue;
    }
    break;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (cursor > 0 && /\s/.test(masked[cursor - 1])) cursor--;

    if (masked[cursor - 1] !== ")" && !/[A-Za-z0-9_]/.test(masked[cursor - 1] ?? "")) {
      break;
    }

    let atIndex = -1;
    if (masked[cursor - 1] === ")") {
      let depth = 0;
      let j = cursor - 1;
      for (; j >= 0; j--) {
        if (masked[j] === ")") depth++;
        else if (masked[j] === "(") {
          depth--;
          if (depth === 0) break;
        }
      }
      const openParen = j;
      let k = openParen - 1;
      while (k >= 0 && /[A-Za-z0-9_.]/.test(masked[k])) k--;
      if (masked[k] === "@") atIndex = k;
      if (atIndex >= 0) {
        const name = masked.slice(atIndex + 1, openParen).trim();
        const args = orig.slice(openParen + 1, cursor - 1).trim();
        annotations.unshift({ name, args, start: atIndex, end: cursor });
        cursor = atIndex;
        continue;
      }
      break;
    } else {
      let k = cursor - 1;
      while (k >= 0 && /[A-Za-z0-9_.]/.test(masked[k])) k--;
      if (masked[k] === "@") atIndex = k;
      if (atIndex >= 0) {
        const name = masked.slice(atIndex + 1, cursor).trim();
        annotations.unshift({ name, args: "", start: atIndex, end: cursor });
        cursor = atIndex;
        continue;
      }
      break;
    }
  }

  return annotations;
}

function shortName(name: string): string {
  return name.split(".").pop() ?? name;
}

function classifyKind(annotations: RawAnnotation[]): ClassKind {
  for (const a of annotations) {
    const short = shortName(a.name);
    if (short in KIND_BY_ANNOTATION) return KIND_BY_ANNOTATION[short];
  }
  return "other";
}

/** A Spring Data repository is an interface extending one of the well-known repository types, with or without @Repository. */
function classifySpringDataInterface(header: string): ClassKind {
  const extendsMatch = header.match(/\bextends\b([\s\S]*)$/);
  if (!extendsMatch) return "other";
  const names = extendsMatch[1].match(/[A-Za-z_$][\w$]*/g) ?? [];
  return names.some((n) => SPRING_DATA_REPOSITORY_TYPES.has(n)) ? "repository" : "other";
}

interface MappingArgs {
  paths: string[];
  methods: string[];
  /** true when a path argument is present but is not a string literal (e.g. a constant) */
  unresolved: boolean;
}

/** Reads paths and HTTP methods from a mapping annotation's raw args, e.g. `("/users")`, `(value = {"/a","/b"}, method = RequestMethod.POST)`. */
function parseMappingArgs(args: string): MappingArgs {
  const paths: string[] = [];
  let target: string | null = null;

  const attr = args.match(/\b(?:value|path)\s*=\s*(\{[^}]*\}|"(?:[^"\\]|\\.)*")/);
  if (attr) {
    target = attr[1];
  } else {
    const trimmed = args.trim();
    if (trimmed.startsWith("{")) {
      target = trimmed.slice(0, trimmed.indexOf("}") + 1);
    } else if (trimmed.startsWith('"')) {
      const lit = trimmed.match(/^"(?:[^"\\]|\\.)*"/);
      target = lit ? lit[0] : null;
    }
  }

  if (target) {
    for (const s of target.matchAll(/"((?:[^"\\]|\\.)*)"/g)) paths.push(s[1]);
  }

  const methods = [...args.matchAll(/RequestMethod\.(\w+)/g)].map((m) => m[1]);

  const hasPathAttr = /\b(?:value|path)\s*=/.test(args);
  const bareFirstArg = args.trim() !== "" && !/^\s*\w+\s*=/.test(args);
  const unresolved = paths.length === 0 && (hasPathAttr || bareFirstArg);

  return { paths, methods, unresolved };
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

/** Joins a class-level prefix and a method path into one normalised path ("/" minimum). */
function joinPath(prefix: string, path: string): string {
  const parts = [prefix, path].map(trimSlashes).filter(Boolean);
  return "/" + parts.join("/");
}

/** Finds the name of the method declared right after a mapping annotation, skipping any further annotations. */
function findMethodName(masked: string, from: number): string {
  let i = from;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] === "@" && !masked.startsWith("@interface", i)) {
      i++;
      while (i < masked.length && /[\w.]/.test(masked[i])) i++;
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] === "(") i = findMatchingParen(masked, i);
      continue;
    }
    break;
  }

  const stop = /[({};]/g;
  stop.lastIndex = i;
  const m = stop.exec(masked);
  if (!m || m[0] !== "(") return "(unknown)";
  const header = masked.slice(i, m.index);
  const nameMatch = header.match(/([A-Za-z_$][\w$]*)\s*$/);
  return nameMatch ? nameMatch[1] : "(unknown)";
}

function extractEndpoints(
  masked: string,
  orig: string,
  classPrefix: { prefix: string; unresolved: boolean }
): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const re = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const name = match[1];
    let args = "";
    let end = match.index + match[0].length;

    let p = end;
    while (p < masked.length && /\s/.test(masked[p])) p++;
    if (masked[p] === "(") {
      const close = findMatchingParen(masked, p);
      args = orig.slice(p + 1, close - 1);
      end = close;
    }
    re.lastIndex = end;

    const parsed = parseMappingArgs(args);
    const methodName = findMethodName(masked, end);

    const httpMethods =
      name === "RequestMapping" && parsed.methods.length > 0
        ? parsed.methods
        : [MAPPING_ANNOTATIONS[name] ?? "ANY"];
    const methodPaths = parsed.paths.length > 0 ? parsed.paths : [""];

    for (const httpMethod of httpMethods) {
      for (const mp of methodPaths) {
        const unresolved = classPrefix.unresolved || parsed.unresolved;
        endpoints.push({
          httpMethod,
          path: unresolved ? "" : joinPath(classPrefix.prefix, mp),
          methodName,
        });
      }
    }
  }

  return endpoints;
}

/** Splits a parameter list at top-level commas (ignoring commas inside <> and ()). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Every simple type name mentioned in a type expression, e.g. `Map<String, List<Foo>>` → Map, String, List, Foo. */
function typeNames(typeText: string): string[] {
  const names = typeText.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [];
  return names.map((n) => n.split(".").pop() as string);
}

/** Strips leading annotations (with balanced parens) and `final` from a parameter, then returns its type names. */
function paramTypeNames(param: string): string[] {
  let p = param.trim();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (p.startsWith("@")) {
      let i = 1;
      while (i < p.length && /[\w.]/.test(p[i])) i++;
      while (i < p.length && /\s/.test(p[i])) i++;
      if (p[i] === "(") i = findMatchingParen(p, i);
      p = p.slice(i).trim();
      continue;
    }
    if (p.startsWith("final ")) {
      p = p.slice(6).trim();
      continue;
    }
    break;
  }
  const typeText = p.replace(/\s*[\w$]+\s*$/, "");
  return typeNames(typeText);
}

function paramListTypeNames(paramList: string): string[] {
  return splitTopLevel(paramList).flatMap(paramTypeNames);
}

/** Skips whitespace, annotations and modifiers starting at `i`, returning the index of the first real token. */
function skipAnnotationsAndModifiers(masked: string, from: number): number {
  let i = from;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] === "@") {
      i++;
      while (i < masked.length && /[\w.]/.test(masked[i])) i++;
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] === "(") i = findMatchingParen(masked, i);
      continue;
    }
    const m = /^[A-Za-z]+/.exec(masked.slice(i, i + 12));
    if (m && MODIFIER_KEYWORDS.has(m[0]) && !/[\w$]/.test(masked[i + m[0].length] ?? "")) {
      i += m[0].length;
      continue;
    }
    break;
  }
  return i;
}

function extractDependencies(
  masked: string,
  className: string,
  classAnnotations: RawAnnotation[]
): string[] {
  const deps = new Set<string>();
  const add = (names: string[]) => names.forEach((n) => deps.add(n));

  // Explicit injection points: @Autowired / @Inject / @Resource on a field,
  // a setter, or a constructor — possibly stacked with other annotations
  // such as @Qualifier("x").
  const injectionRegex = /@(?:Autowired|Inject|Resource)\b/g;
  let m: RegExpExecArray | null;
  while ((m = injectionRegex.exec(masked)) !== null) {
    let pos = m.index + m[0].length;
    while (pos < masked.length && /\s/.test(masked[pos])) pos++;
    if (masked[pos] === "(") pos = findMatchingParen(masked, pos);

    const start = skipAnnotationsAndModifiers(masked, pos);
    const term = /[;=({]/g;
    term.lastIndex = start;
    const t = term.exec(masked);
    if (!t) continue;
    const header = masked.slice(start, t.index);
    // annotation sat inside a parameter list rather than on a member
    if (header.includes(")") || splitTopLevel(header).length > 1) continue;

    if (t[0] === ";" || t[0] === "=") {
      add(typeNames(header.replace(/\s*[\w$]+\s*$/, "")));
    } else if (t[0] === "(") {
      const close = findMatchingParen(masked, t.index);
      add(paramListTypeNames(masked.slice(t.index + 1, close - 1)));
    }
  }

  // Implicit constructor injection (Spring 4.3+): a constructor named after
  // the class. Skips `new ClassName(...)` calls and `.ClassName(...)` calls.
  const ctorRegex = new RegExp(`\\b${className}\\s*\\(`, "g");
  while ((m = ctorRegex.exec(masked)) !== null) {
    let k = m.index;
    while (k > 0 && /\s/.test(masked[k - 1])) k--;
    if (masked[k - 1] === "." || wordEndingAt(masked, k).word === "new") continue;

    const open = masked.indexOf("(", m.index);
    const close = findMatchingParen(masked, open);
    const tail = /\s*(?:throws\s+[\w.$,\s]+?)?\s*\{/y;
    tail.lastIndex = close;
    if (!tail.test(masked)) continue;
    add(paramListTypeNames(masked.slice(open + 1, close - 1)));
  }

  // Lombok: @RequiredArgsConstructor generates a constructor taking every
  // non-static final field that has no initialiser.
  if (classAnnotations.some((a) => shortName(a.name) === "RequiredArgsConstructor")) {
    const fieldRegex =
      /\b((?:(?:private|protected|public|static|final|transient|volatile)\s+)+)([\w.$]+(?:\s*<[^;=(){}]*>)?)\s+[\w$]+\s*;/g;
    while ((m = fieldRegex.exec(masked)) !== null) {
      const modifiers = m[1];
      if (/\bfinal\b/.test(modifiers) && !/\bstatic\b/.test(modifiers)) add(typeNames(m[2]));
    }
  }

  deps.delete(className); // a class doesn't depend on itself
  for (const ignored of IGNORED_TYPE_NAMES) deps.delete(ignored);

  return Array.from(deps);
}

/**
 * Parses a single .java file's source and returns every class/interface/enum
 * declaration carrying a recognised Spring role (or extending a Spring Data
 * repository type), with its annotations, kind, endpoints, and raw dependency
 * type names (not yet filtered against the whole-repo class set — the caller
 * does that once all files are parsed).
 */
export function parseJavaFile(source: string, filePath: string): ClassInfo[] {
  const stripped = stripComments(source);
  const masked = maskStrings(stripped);
  const results: ClassInfo[] = [];

  const declRegex = /\b(class|interface|enum|record)\s+(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = declRegex.exec(masked)) !== null) {
    const keyword = match[1];
    const className = match[2];
    const declKeywordIndex = match.index;
    // "record" is only a declaration when a component list follows (`record Name(...)`, optionally generic).
    if (keyword === "record" && !/^\s*(?:<[^>{}]*>)?\s*\(/.test(masked.slice(match.index + match[0].length, match.index + match[0].length + 200))) {
      continue;
    }

    const braceIndex = masked.indexOf("{", declKeywordIndex);
    if (braceIndex === -1) continue;
    const bodyEnd = findMatchingBrace(masked, braceIndex);
    const bodyMasked = masked.slice(braceIndex + 1, bodyEnd - 1);
    const bodyOrig = stripped.slice(braceIndex + 1, bodyEnd - 1);

    const annotations = collectAnnotationsBefore(masked, stripped, declKeywordIndex);
    let kind = classifyKind(annotations);
    if (kind === "other" && keyword === "interface") {
      kind = classifySpringDataInterface(masked.slice(declKeywordIndex, braceIndex));
    }

    // Only classes with a recognised Spring role are reported — plain
    // POJOs/utility classes are noise for an architecture-map report.
    if (kind === "other") continue;

    const classMapping = annotations.find((a) => shortName(a.name) === "RequestMapping");
    let classPrefix = { prefix: "", unresolved: false };
    if (classMapping) {
      const parsed = parseMappingArgs(classMapping.args);
      classPrefix = { prefix: parsed.paths[0] ?? "", unresolved: parsed.unresolved };
    }

    const configProps = annotations.find((a) => shortName(a.name) === "ConfigurationProperties");
    const configPrefix = configProps ? extractConfigPrefix(configProps.args) : undefined;

    results.push({
      ...(configPrefix !== undefined ? { configPrefix } : {}),
      name: className,
      kind,
      file: filePath,
      annotations: annotations.map((a) => a.name),
      endpoints: kind === "controller" ? extractEndpoints(bodyMasked, bodyOrig, classPrefix) : [],
      dependsOn: extractDependencies(bodyMasked, className, annotations),
      rawBody: bodyOrig.trim(),
    });
  }

  return results;
}
