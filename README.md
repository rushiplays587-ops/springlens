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

**v0.1 — early skeleton.** The CLI runs and validates a target repo; the actual
analysis (structural map, dependency-risk report, codebase Q&A) is being built
sprint by sprint. See [Roadmap](#roadmap) below.

## Usage

```bash
npm install
npm run build
npm start -- ./path-to-your-spring-boot-repo
```

## Roadmap

- [x] **Sprint 0** — project scaffold, CLI skeleton
- [ ] **Sprint 1** — structural extraction: controllers → services → repositories →
      entities, bean-wiring graph (static analysis, no AI yet)
- [ ] **Sprint 2** — AI narrative layer: plain-English explanations of each module
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
