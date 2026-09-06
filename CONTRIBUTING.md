# Contributing

## Getting started

```bash
npm install
npm test        # unit + simulation
npm run typecheck
```

No database and no Docker. There are two reasons, and only one of them is the obvious
one. The discovery engine and the GraphRAG index are pure functions by design, so they
need no persistence at all. Everything that *does* need persistence runs against real
Postgres compiled to WASM, in process, via PGlite — so `npm install && npm test` is the
whole setup.

CI runs the identical suite a second time against Postgres 16 and that run is the
authoritative one: PGlite is a WASM build and is not byte-identical to server Postgres,
so a divergence surfaces on your pull request rather than in production. To run against
a server yourself:

```bash
DATABASE_URL=postgres://... npm run test:postgres
```

Regions come from a vendored GeoNames extract in `data/geonames/`, so seeding needs no
network:

```bash
PGLITE_DATA_DIR=./.pgdata npm run regions:seed
```

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
   may import the database. That boundary is what makes the simulation harness possible,
   and `tests/unit/architecture.test.ts` fails if it is crossed.
5. **Rules live in the service layer.** `src/lib/services/` is the seam everything is
   tested at. Route handlers authenticate and delegate; they hold no rules. Where a
   decision in `docs/adr/` can be a database constraint, it is one — an invariant
   enforced only in application code becomes folklore as soon as someone writes a
   second caller.
6. **Add a test that would have caught your bug.** For scoring changes, prefer a planted
   fixture in `tests/simulation/` over a unit test with hand-picked numbers.

## Style

TypeScript strict mode, including `noUncheckedIndexedAccess`. Comments explain *why*,
not *what* — especially for anything where the obvious implementation is wrong. There
are several such places and they are commented at length on purpose.
