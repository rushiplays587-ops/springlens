import { ClassInfo, ClassKind, Endpoint } from "./model.js";

/**
 * v1 extraction strategy: annotation-driven heuristics, not a full Java AST parse.
 *
 * Spring's structure is almost entirely expressed through annotations
 * (@RestController, @Service, @Autowired, @GetMapping, ...), which are
 * regular, predictable tokens — so a careful text-based scan (after stripping
 * comments/strings, so annotation-shaped text inside them can't false-positive)
 * gets correct results for the common cases without the complexity of a real
 * parser. Deliberately documented limitation, not an oversight: deeply nested
 * inner classes are attributed to their enclosing class, and unusual
 * formatting (e.g. annotations split mid-token across lines in strange ways)
 * can be missed. Upgrading to a real AST parser (e.g. java-parser) is a
 * reasonable future sprint if this stops being accurate enough in practice.
 */

const KIND_BY_ANNOTATION: Record<string, ClassKind> = {
  RestController: "controller",
  Controller: "controller",
  Service: "service",
  Repository: "repository",
  Entity: "entity",
  Configuration: "configuration",
  Component: "component",
};

const MAPPING_ANNOTATIONS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: "MAPPING",
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
]);

/**
 * Blanks out comments (preserving line breaks, so later line/position
 * reasoning stays roughly aligned) so annotation-shaped text inside a
 * comment can't false-positive as real code. String/char literals are
 * passed through verbatim — deliberately not blanked, because we need the
 * actual quoted path values inside annotations like @GetMapping("/users")
 * to survive for extractPathFromArgs to read. The scanner still tracks
 * string/char boundaries so a "//" or "/*" that happens to appear inside a
 * string literal isn't mistaken for the start of a real comment.
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

    if (c === '"') {
      result += c;
      i++;
      while (i < n && source[i] !== '"') {
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

    if (c === "'") {
      result += c;
      i++;
      while (i < n && source[i] !== "'") {
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

/** Finds the index just past the matching ')' for a '(' at openParenIndex. */
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

/** Finds the index just past the matching '}' for a '{' at openBraceIndex. */
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
  args: string; // raw text between the parens, "" if no parens
  start: number;
  end: number;
}

/**
 * Scans backwards from `beforeIndex` collecting the contiguous run of
 * annotations immediately preceding it (skipping whitespace between them).
 */
const MODIFIER_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "final",
  "abstract",
  "strictfp",
]);

/** Reads the identifier ending at (and not including) `end`. */
function wordEndingAt(src: string, end: number): { word: string; start: number } {
  let k = end;
  while (k > 0 && /[A-Za-z0-9_]/.test(src[k - 1])) k--;
  return { word: src.slice(k, end), start: k };
}

function collectAnnotationsBefore(src: string, beforeIndex: number): RawAnnotation[] {
  const annotations: RawAnnotation[] = [];
  let cursor = beforeIndex;

  // Modifiers (public, final, ...) sit between the annotations and the
  // class/method keyword — skip over any of them first so the annotation
  // scan below isn't fooled into stopping at "public" and giving up.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (cursor > 0 && /\s/.test(src[cursor - 1])) cursor--;
    const { word, start } = wordEndingAt(src, cursor);
    if (word && MODIFIER_KEYWORDS.has(word)) {
      cursor = start;
      continue;
    }
    break;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // skip whitespace backwards
    while (cursor > 0 && /\s/.test(src[cursor - 1])) cursor--;

    if (src[cursor - 1] !== ")" && !/[A-Za-z0-9_]/.test(src[cursor - 1] ?? "")) {
      break;
    }

    // We're at the end of either "@Name(...)" or "@Name". Walk back to find '@'.
    let atIndex = -1;
    if (src[cursor - 1] === ")") {
      // find the matching '(' by scanning backwards with a depth counter
      let depth = 0;
      let j = cursor - 1;
      for (; j >= 0; j--) {
        if (src[j] === ")") depth++;
        else if (src[j] === "(") {
          depth--;
          if (depth === 0) break;
        }
      }
      const openParen = j;
      // now walk back further over the identifier before '('
      let k = openParen - 1;
      while (k >= 0 && /[A-Za-z0-9_.]/.test(src[k])) k--;
      if (src[k] === "@") atIndex = k;
      if (atIndex >= 0) {
        const name = src.slice(atIndex + 1, openParen).trim();
        const args = src.slice(openParen + 1, cursor - 1).trim();
        annotations.unshift({ name, args, start: atIndex, end: cursor });
        cursor = atIndex;
        continue;
      }
      break;
    } else {
      let k = cursor - 1;
      while (k >= 0 && /[A-Za-z0-9_.]/.test(src[k])) k--;
      if (src[k] === "@") atIndex = k;
      if (atIndex >= 0) {
        const name = src.slice(atIndex + 1, cursor).trim();
        annotations.unshift({ name, args: "", start: atIndex, end: cursor });
        cursor = atIndex;
        continue;
      }
      break;
    }
  }

  return annotations;
}

function classifyKind(annotations: RawAnnotation[]): ClassKind {
  for (const a of annotations) {
    const short = a.name.split(".").pop() ?? a.name;
    if (short in KIND_BY_ANNOTATION) return KIND_BY_ANNOTATION[short];
  }
  return "other";
}

/** Pulls a "value" or bare string argument out of a mapping annotation's raw args, e.g. `("/users")` or `(value = "/users", method = ...)`. */
function extractPathFromArgs(args: string): string {
  const valueMatch = args.match(/value\s*=\s*"([^"]*)"/);
  if (valueMatch) return valueMatch[1];
  const bareMatch = args.match(/"([^"]*)"/);
  if (bareMatch) return bareMatch[1];
  return "";
}

function extractEndpoints(classBody: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const annotationCallRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/g;

  let match: RegExpExecArray | null;
  while ((match = annotationCallRegex.exec(classBody)) !== null) {
    const name = match[1];
    let args = "";
    let afterAnnotation = match.index + match[0].length;

    if (classBody[afterAnnotation] === "(") {
      const closeIdx = findMatchingParen(classBody, afterAnnotation);
      args = classBody.slice(afterAnnotation + 1, closeIdx - 1);
      afterAnnotation = closeIdx;
    }

    // Find the next method declaration after this annotation: skip any other
    // annotations/whitespace, then look for `... name(` before the next `{`.
    const rest = classBody.slice(afterAnnotation);
    const methodMatch = rest.match(/^[\s\S]*?(\w+)\s*\([^)]*\)\s*\{/);
    const methodName = methodMatch ? methodMatch[1] : "(unknown)";

    endpoints.push({
      httpMethod: MAPPING_ANNOTATIONS[name] ?? "MAPPING",
      path: extractPathFromArgs(args),
      methodName,
    });
  }

  return endpoints;
}

function extractDependencies(classBody: string, className: string): string[] {
  const deps = new Set<string>();

  // @Autowired field injection: @Autowired ... Type name;
  const autowiredFieldRegex =
    /@Autowired\s*(?:\([^)]*\))?\s*(?:private|protected|public)?\s*(?:final\s+)?(\w+)\s*(?:<[^>]*>)?\s+\w+\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = autowiredFieldRegex.exec(classBody)) !== null) {
    deps.add(m[1]);
  }

  // Constructor injection: public ClassName(Type1 a, Type2 b) — Spring 4.3+
  // implicit autowiring on a class's sole constructor. We match any
  // constructor whose name equals the class name, since a false match on an
  // unrelated method sharing that name isn't possible in valid Java.
  const ctorRegex = new RegExp(`\\b${className}\\s*\\(([^)]*)\\)\\s*\\{`, "g");
  while ((m = ctorRegex.exec(classBody)) !== null) {
    const params = m[1];
    const paramTypeRegex = /(?:^|,)\s*(?:final\s+)?(\w+)\s*(?:<[^>]*>)?\s+\w+/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramTypeRegex.exec(params)) !== null) {
      deps.add(pm[1]);
    }
  }

  deps.delete(className); // a class doesn't depend on itself
  for (const ignored of IGNORED_TYPE_NAMES) deps.delete(ignored);

  return Array.from(deps);
}

/**
 * Parses a single .java file's (already comment/string-stripped) source and
 * returns every top-level class/interface/enum declaration found, with its
 * annotations, Spring "kind" classification, endpoints, and raw dependency
 * type names (not yet filtered against the whole-repo class set — the
 * caller does that once all files are parsed).
 */
export function parseJavaFile(source: string, filePath: string): ClassInfo[] {
  const stripped = stripComments(source);
  const results: ClassInfo[] = [];

  const declRegex = /\b(class|interface|enum)\s+(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = declRegex.exec(stripped)) !== null) {
    const className = match[2];
    const declKeywordIndex = match.index;

    const braceIndex = stripped.indexOf("{", declKeywordIndex);
    if (braceIndex === -1) continue;
    const bodyEnd = findMatchingBrace(stripped, braceIndex);
    const classBody = stripped.slice(braceIndex + 1, bodyEnd - 1);

    const annotations = collectAnnotationsBefore(stripped, declKeywordIndex);
    const kind = classifyKind(annotations);

    // Only classes carrying a recognized Spring annotation are reported —
    // plain POJOs/utility classes are noise for an architecture-map report.
    if (kind === "other") continue;

    results.push({
      name: className,
      kind,
      file: filePath,
      annotations: annotations.map((a) => a.name),
      endpoints: kind === "controller" ? extractEndpoints(classBody) : [],
      dependsOn: extractDependencies(classBody, className),
      rawBody: classBody.trim(),
    });
  }

  return results;
}
