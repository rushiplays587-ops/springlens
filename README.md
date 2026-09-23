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

Not built yet: `application.yml` / properties analysis, JPA entity
relationship mapping, upgrade-path guidance beyond the two rules above, and
codebase Q&A. See the [Roadmap](#roadmap).

## Usage

```bash
npm install
npm run build

# local structural report — nothing leaves your machine:
npm start -- ./path-to-your-spring-boot-repo

# also generate AI narrative (sends class source to Anthropic — see Privacy):
export ANTHROPIC_API_KEY=sk-ant-...
npm start -- ./path-to-your-spring-boot-repo --ai
```

The report is written to `springlens-report.md` inside the scanned repo. It
lists the scanned directory's name only, not absolute paths.

## Privacy

By default SpringLens is entirely local. With `--ai` it sends each annotated
class's source (up to 4,000 characters per class, **string literals
included** — so URLs, connection strings or keys hard-coded in a class would
be sent) to the Anthropic API, and prints what it is about to send. AI is
opt-in for that reason; passing `--ai` without `ANTHROPIC_API_KEY` just
produces the local report. A failed AI call for one class falls back to the
structural entry for that class; it doesn't stop the run. Repository source is
treated as untrusted data in the prompt.

## How the extraction works

Spring's structure is almost entirely expressed through annotations
(`@RestController`, `@Service`, `@Autowired`, `@GetMapping`, ...), which are
regular and predictable — so v1 uses careful annotation-driven text scanning
rather than a full Java AST parser. Comments are stripped, and the contents of
string literals are masked during structural scanning, so an annotation-shaped
comment or string, or a `}` inside a string, can't be mistaken for code;
annotation values are then read from the original text.

Known limitations (documented, not oversights):

- Records and Kotlin/Groovy sources are not parsed.
- Classes with the same simple name in different packages are merged by name.
- Annotation arguments that are constants (e.g. `@GetMapping(Paths.USERS)`)
  are shown as "path not statically resolvable" rather than guessed.
- `@Bean`-method parameter injection is not followed.
- Gradle: string notation and the Spring Boot plugin version only — no map
  notation, no multi-project builds. Maven `${property}` versions resolve only
  from the same pom's `<properties>`; otherwise they are reported as
  "check by hand".

If accuracy stops being enough in practice, a real AST parser (e.g.
`java-parser`) is the planned upgrade — see the doc comment at the top of
`src/parser.ts`.

```bash
npm test   # builds, then runs the regression suites (parser, scanner, dependency scan, narration, fixture)
```

## Roadmap

- [x] **Sprint 0** — project scaffold, CLI skeleton
- [x] **Sprint 1** — structural extraction: controllers → services → repositories →
      entities, bean-wiring graph (static analysis, no AI)
- [x] **Sprint 2** — AI narrative layer: plain-English explanation per class
- [x] **Sprint 3** — dependency-risk report against a small curated list
- [x] **Hardening** — independent code review and adversarial testing; parser,
      scanner and CLI fixes; AI made opt-in
- [ ] **Sprint 4** — "ask the codebase": Q&A grounded in the actual repo (RAG)
- [ ] **Sprint 5** — polish: `application.yml` analysis, clean HTML report output, docs
- [ ] **Sprint 6** — launch

## Why open source

Distribution for a dev tool built by a solo maker happens through the tool
itself being useful and visible (GitHub, package registries, developer
communities) — not through an ads budget. Open-sourcing the core is the
distribution strategy, not just a licensing choice.

## License

MIT — see [LICENSE](LICENSE).
