# SpringLens

Onboarding and dependency-risk analysis for legacy **Java/Spring Boot**
codebases — built by a practicing Java tech lead, for teams inheriting Spring
Boot systems they didn't write.

Generic AI code-onboarding tools (Swimm, DeepWiki, Glean, and others) are
language-agnostic. SpringLens is built for one stack: it reads Spring's own
vocabulary — stereotype annotations, endpoint mappings, bean wiring — and
writes an architecture map of the codebase you just inherited.

## What it does today (v0.1)

Point it at a Spring Boot repo and it writes `springlens-report.md`:

- **Architecture map** — every controller, controller advice, service,
  repository (including Spring Data interfaces), entity, configuration and
  component class it finds.
- **Real endpoints** — HTTP method, full path (class-level `@RequestMapping`
  prefix joined in) and handler method for each controller.
- **Who depends on whom** — constructor injection (explicit and implicit),
  `@Autowired` / `@Inject` / `@Resource` on fields and setters, and Lombok
  `@RequiredArgsConstructor`.
- **Dependency risk** — Maven (including multi-module) and Gradle
  dependencies checked against a small curated list: the Log4Shell
  fixed-version boundary and Spring Boot's end-of-life. This is **not** a live
  vulnerability database; use OWASP dependency-check, Snyk or Dependabot for
  full coverage.
- **Optional AI narrative** — a plain-English explanation per class (see
  [Privacy](#privacy)).
- **Configuration files** — `application*` and `bootstrap*` files (`.yml`,
  `.yaml`, `.properties`, multi-document YAML with `---`) summarised per file:
  application name, port and context path, profiles, datasource kind and host,
  Eureka and config-server settings, **gateway routes** (id, target, predicates,
  filters) as a table, and the property groups present. Classes that bind
  `@ConfigurationProperties(prefix = ...)` or read `@Value("${...}")` are linked
  to the keys they use, and keys no scanned file defines are flagged. Secrets are
  redacted (see [Configuration files](#configuration-files)).
- **HTML report** — `--html` also writes `springlens-report.html`, the same
  report as one self-contained page (inline styles, no scripts, no external
  requests), readable on screen and in print.
- **Ask the codebase** — `springlens ask <repo> "<question>"` ranks the repo's
  classes and config files against your question and prints the best matches,
  locally (see [Asking questions](#asking-questions)).

Not built yet: JPA entity relationship mapping, upgrade-path guidance beyond the
two rules above, and evaluation of Spring profiles. See the [Roadmap](#roadmap).

## Usage

```bash
npm install
npm run build

# local structural report — nothing leaves your machine:
npm start -- ./path-to-your-spring-boot-repo

# also write springlens-report.html (self-contained page, nothing leaves your machine):
npm start -- ./path-to-your-spring-boot-repo --html

# also generate AI narrative (sends class source to Anthropic — see Privacy):
export ANTHROPIC_API_KEY=sk-ant-...
npm start -- ./path-to-your-spring-boot-repo --ai
```

The report is written to `springlens-report.md` inside the scanned repo (and
`springlens-report.html` with `--html`). It lists the scanned directory's name
only, not absolute paths. Everything taken from the repo — class names, paths,
config keys and values — is treated as untrusted text: it is escaped in the HTML
and placed in code spans in the Markdown, and the HTML page carries a
Content-Security-Policy that forbids scripts and network access.

## Configuration files

SpringLens reads `application.*` and `bootstrap.*` files (also
`application-<profile>.*`) found anywhere in the repo except build output and
`src/test`. YAML is parsed with the [`yaml`](https://github.com/eemeli/yaml)
package (the tool's one runtime dependency besides the Anthropic SDK; it has no
dependencies of its own), so anchors, multi-line strings, lists and
multi-document files are handled properly. `.properties` files, including
Spring's `#---` document separator, use a small dedicated reader.

Files are shown **as written**. SpringLens does not evaluate Spring profiles,
merge files, expand `${...}` placeholders, resolve environment variables or fetch
from a config server: a value may be overridden at runtime, and a key missing from
the scanned files may still be set elsewhere. Gateway routes are read from
properties (`spring.cloud.gateway...routes`, including the `server.webflux` and
`server.webmvc` forms); routes declared in Java (`RouteLocator` beans) are not seen.
`spring.config.import` files are listed but not followed.

**Secrets.** Config files hold passwords and tokens, so values are redacted at
the moment a file is read, before anything is stored, printed or sent anywhere:

- the value of any key with `password`, `passwd`, `pass`, `pwd`, `pw`, `secret`, `token`,
  `key`, `credential`, `private`, `auth`, `cert`, `salt`, `passphrase`, `signature`, `sig`,
  `hmac`, `cookie`, `sessionid`, `jwt`, `dsn` or `pfx` in its name is replaced by
  `[redacted]` (the key name is kept; a bare `${ENV_VAR}` reference with no default is
  shown, since it reveals nothing);
- credentials in URLs (`user:pass@host`, `redis://:pass@host`, a lone `token@host`, Oracle
  `user/pass@host`), secret-looking parameters written as `name=value`, `name: value` or
  `"name":"value"` inside any value (query strings, JDBC properties, JSON in a property),
  `Basic` / `Bearer` credentials, header values on gateway filters and predicates whose
  header name looks secret, and the default in a secret-named placeholder
  (`${DB_PASSWORD:changeme}`) are redacted in any value;
- values shaped like well-known tokens (AWS, GitHub, GitLab, Slack incl. webhook paths,
  OpenAI/Anthropic style, JWTs, PEM private keys) and long opaque letter-and-digit strings
  are redacted.

This is pattern-based and errs toward hiding too much (a key such as
`monkey-mode` matches `key`). It cannot recognise an arbitrary secret stored under
an innocent-looking key with an innocent-looking value, so review the report
before sharing it. Look-alike Unicode letters (a Cyrillic "а" in `password`) are not
folded. Config files are also size-limited (256 KB), depth-limited and
alias-limited, and no single value is scanned beyond 4,096 characters; a file that cannot be parsed is listed as unparsable and the rest of
the scan continues. Nothing in a config file is ever executed.

## Asking questions

```bash
npm start -- ask ./path-to-your-spring-boot-repo "where is user login handled"
npm start -- ask ./path-to-your-spring-boot-repo "which class talks to the database"
```

**Default mode is fully local.** SpringLens indexes every class it found (name,
kind, annotations, endpoint paths and handler names, injected dependencies,
file path and source words) and every config file (application name, port,
routes, datasource, keys and values), so questions like "how does the api
gateway route requests" or "which port does the config server run on" are
answered from the config itself. It ranks them against your question with BM25, and
prints the top five: file, kind, endpoints, what each depends on, what uses
it, and which of your words matched. Matches on a class's name, kind or
endpoints count for more than words in its body. No AI answer is generated and
nothing leaves your machine.

**With `--ai`** it additionally sends your question plus the source of *only
those top classes* (up to 4,000 characters each, string literals included) and
any retrieved config files (as `key = value` lines, at most 60 lines each, with
secrets redacted a second time before sending) to the Anthropic API and prints a
written answer that cites class names. It
prints exactly which classes are being sent first. Like the report, this needs
`ANTHROPIC_API_KEY`; without it `--ai` just prints the local results. If nothing
matches your question, nothing is sent. Repository source is treated as
untrusted data in the prompt.

What it can and cannot do:

- It is keyword ranking, not understanding. It splits camelCase and snake_case,
  ignores plurals and common verb endings, and knows a handful of Spring-flavoured
  related words (for example *database* also looks for repositories and JPA), but
  a class that uses different words from your question can be missed. Name things
  the way the code does when you can.
- It only knows the classes SpringLens extracts (Spring-annotated classes; see
  the limitations below), so plain helper classes without a Spring annotation are
  not searchable.
- The AI answer sees only the retrieved classes, not the whole repo, and is told
  to say so when they are not enough. Treat it as a pointer to the right code,
  not a verdict.
- There are no embeddings and no extra dependencies.
- To scan a directory literally named `ask`, write `./ask`.

## Privacy

By default SpringLens is entirely local, including `ask`. With `--ai` it sends each annotated
class's source (up to 4,000 characters per class, **string literals
included** — so URLs, connection strings or keys hard-coded in a class would
be sent) to the Anthropic API, and prints what it is about to send. AI is
opt-in for that reason; passing `--ai` without `ANTHROPIC_API_KEY` just
produces the local report. A failed AI call for one class falls back to the
structural entry for that class; it doesn't stop the run. Repository source is
treated as untrusted data in the prompt. `ask --ai` sends far less: your
question, the top retrieved classes and, if they matched, the config files
that scored highest, as `key = value` lines with secrets redacted (see
[Asking questions](#asking-questions)). **Config values are redacted before they can be sent**
(within the limits of the pattern-based redaction described there): they are redacted when the file is read (see
[Configuration files](#configuration-files)) and again when a prompt is built.
The per-class `--ai` narrative does not include config files, but a secret
hard-coded as a string literal inside a Java class is still part of that class's
source and would be sent.

## How the extraction works

Spring's structure is almost entirely expressed through annotations
(`@RestController`, `@Service`, `@Autowired`, `@GetMapping`, ...), which are
regular and predictable — so v1 uses careful annotation-driven text scanning
rather than a full Java AST parser. Comments are stripped, and the contents of
string literals are masked during structural scanning, so an annotation-shaped
comment or string, or a `}` inside a string, can't be mistaken for code;
annotation values are then read from the original text.

Known limitations (documented, not oversights):

- Kotlin/Groovy sources are not parsed. Records are picked up only when they
  carry a Spring role annotation (for example `@ConfigurationProperties`);
  their components are not followed as dependencies, and plain DTO records are
  not listed.
- Test sources (`src/test`) are skipped, so test-only configuration classes do
  not appear in the map.
- Classes with the same simple name in different packages are merged by name.
- Annotation arguments that are constants (e.g. `@GetMapping(Paths.USERS)`)
  are shown as "path not statically resolvable" rather than guessed.
- `@Bean`-method parameter injection is not followed.
- Gradle: string notation and the Spring Boot plugin version only — no map
  notation, no multi-project builds. Maven `${property}` versions resolve from
  the pom's own `<properties>` and those of its parent poms inside the repo;
  otherwise they are reported as "check by hand". A module also inherits
  `<dependencyManagement>` versions from those in-repo parents; a parent outside the repo (including `spring-boot-starter-parent`'s
  own managed versions) is not read, so a dependency whose version comes only from
  there has no version to check. A parent is only followed when the pom at its
  `<relativePath>` really has the declared groupId and artifactId. Maven
  `<profiles>`, `<build>` and `<reporting>` (plugin dependencies) are ignored, and
  modules nested more than 10 levels deep are not scanned.

If accuracy stops being enough in practice, a real AST parser (e.g.
`java-parser`) is the planned upgrade — see the doc comment at the top of
`src/parser.ts`.

```bash
npm test   # builds, then runs the regression suites (parser, scanner, dependency scan, config and redaction, report and HTML, narration, ask, CLI, fixtures)
```

## Roadmap

- [x] **Sprint 0** — project scaffold, CLI skeleton
- [x] **Sprint 1** — structural extraction: controllers → services → repositories →
      entities, bean-wiring graph (static analysis, no AI)
- [x] **Sprint 2** — AI narrative layer: plain-English explanation per class
- [x] **Sprint 3** — dependency-risk report against a small curated list
- [x] **Hardening** — independent code review and adversarial testing; parser,
      scanner and CLI fixes; AI made opt-in
- [x] **Sprint 4** — "ask the codebase": local keyword retrieval, with an
      opt-in AI answer over only the retrieved classes
- [x] **Sprint 5** — `application.yml`/properties analysis (with secret redaction),
      gateway routing table, config-aware `ask`, self-contained HTML report
- [ ] **Sprint 6** — launch

## Why open source

Distribution for a dev tool built by a solo maker happens through the tool
itself being useful and visible (GitHub, package registries, developer
communities) — not through an ads budget. Open-sourcing the core is the
distribution strategy, not just a licensing choice.

## License

MIT — see [LICENSE](LICENSE).
