# Contributing

## Getting started

```bash
npm install
npm test        # unit + simulation
npm run typecheck
```

No database or Docker is needed for the current code — the discovery engine and the
GraphRAG index are pure functions by design, precisely so they can be developed and
tested in isolation.

## What we especially want help with

- **Adversarial review of the scoring maths.** `docs/algorithm.md` explains every
  decision. If a factor can be gamed, we want to know, ideally as a failing test in
  `tests/simulation/`.
- **Tactic library content.** `src/lib/organizing/tactics.ts` needs real templates from
  people who have actually run these actions.
- **Jurisdiction know-your-rights content.**
- **An LLM extractor** implementing the `Extractor` interface, as an opt-in alongside
  the deterministic default.

## Ground rules for changes

1. **Do not turn the bridging score into a popularity score.** Taking the minimum across
   opinion groups is the point. There is a test that fails if this changes.
2. **Do not make readiness an arithmetic mean.** The factors must stay
   non-substitutable.
3. **Keep the default path offline.** New required dependencies on a hosted API will be
   declined. Pluggable and opt-in is fine.
4. **Pure functions stay pure.** Nothing in `src/lib/discovery/` or `src/lib/graphrag/`
   may import the database. That boundary is what makes the simulation harness possible.
5. **Add a test that would have caught your bug.** For scoring changes, prefer a planted
   fixture in `tests/simulation/` over a unit test with hand-picked numbers.

## Style

TypeScript strict mode, including `noUncheckedIndexedAccess`. Comments explain *why*,
not *what* — especially for anything where the obvious implementation is wrong. There
are several such places and they are commented at length on purpose.
