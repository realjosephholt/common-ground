# Common Ground — agent guide

Open-source platform for finding causes with enough shared support to act on, and for
organising the action itself. Start with `README.md`; `docs/algorithm.md` explains the
scoring, and `docs/graphrag.md` the knowledge graph.

Before changing scoring or retrieval, read `CONTRIBUTING.md` — several design decisions
there are load-bearing and have tests that fail if they are reversed.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `realjosephholt/common-ground`, via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, with label strings equal to their names.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
