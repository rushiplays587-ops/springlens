# SpringLens

AI-powered onboarding and dependency-risk analysis for legacy **Java/Spring Boot**
codebases — built by a practicing Java tech lead, for teams inheriting Spring Boot
systems they didn't write.

Generic AI code-onboarding tools (Swimm, DeepWiki, Glean, and others) are
language-agnostic — they treat a Spring Boot app the same as any other codebase.
SpringLens doesn't: it understands `@Autowired` bean wiring, `application.yml`
config sprawl, JPA/Hibernate entity relationships, and known Spring Boot
version-upgrade breaking changes, because that's the only stack it's built for.

## Status

**v0.1 — structural extraction works.** Point it at a Spring Boot repo and it
writes a Markdown architecture map: every controller/service/repository/entity
it found, each controller's real endpoints, and who depends on whom. AI
narrative, dependency-risk analysis, and codebase Q&A are still coming — see
[Roadmap](#roadmap).

## Usage

```bash
npm install
npm run build

# structural report only (no API key needed):
npm start -- ./path-to-your-spring-boot-repo --no-ai

# with AI narrative (plain-English explanation per class):
export ANTHROPIC_API_KEY=sk-ant-...
npm start -- ./path-to-your-spring-boot-repo
# writes springlens-report.md inside that repo either way
```

Missing an API key isn't an error — SpringLens still writes the full
structural report, just without the narrative text. A single class's AI call
failing (rate limit, network blip) doesn't take down the run either; that one
class just falls back to structural-only in the final report.

## How the extraction works

Spring's structure is almost entirely expressed through annotations
(`@RestController`, `@Service`, `@Autowired`, `@GetMapping`, ...), which are
regular and predictable — so v1 uses careful annotation-driven text scanning
rather than a full Java AST parser. Comments are stripped before scanning (so
an example annotation mentioned in a comment can't be picked up as real code);
string literals are left intact (so real path values inside annotations
survive). This is a deliberate v1 tradeoff, not an oversight — see the doc
comment at the top of `src/parser.ts` for its known limitations and when a
real AST parser would be worth the added complexity.

```bash
npm test   # runs the fixture-based regression suite in src/build.test.ts
```

## Roadmap

- [x] **Sprint 0** — project scaffold, CLI skeleton
- [x] **Sprint 1** — structural extraction: controllers → services → repositories →
      entities, bean-wiring graph (static analysis, no AI yet)
- [x] **Sprint 2** — AI narrative layer: plain-English explanation per class,
      graceful fallback with no API key
- [ ] **Sprint 3** — dependency-risk report: outdated/vulnerable Maven/Gradle
      dependencies, flagged Spring Boot upgrade breaking changes
- [ ] **Sprint 4** — "ask the codebase": Q&A grounded in the actual repo (RAG)
- [ ] **Sprint 5** — polish: clean HTML report output, docs
- [ ] **Sprint 6** — launch

## Why open source

Distribution for a dev tool built by a solo maker happens through the tool
itself being useful and visible (GitHub, package registries, developer
communities) — not through an ads budget. Open-sourcing the core is the
distribution strategy, not just a licensing choice.

## License

MIT — see [LICENSE](LICENSE).
