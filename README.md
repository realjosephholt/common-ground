# Common Ground

**Find the causes that enough people actually share — then organise the action.**

Common Ground is an open-source platform for lawful, nonviolent collective action. It
does two things that existing tools do badly:

1. **Discovery.** It finds proposals with *bridging* support — agreement that crosses
   opinion divides rather than pooling inside one — and combines that with concentrated
   commitment and a real target to judge whether action is genuinely possible.
2. **Execution.** It scaffolds the action itself: tactics, roles, shifts, supplies,
   decisions, safety, and an after-action record that feeds back into what works.

Status: **early.** The discovery engine and the GraphRAG index are built and tested.
The web app and database layer are next. See [Roadmap](#roadmap).

---

## The idea in one formula

Almost every platform scores a cause by how many people agree. That number barely
predicts whether anything will happen. Common Ground scores **readiness** instead:

```
readiness = (bridge · commitment · density · concreteness) ^ (1/4)
```

| Factor | What it measures |
|---|---|
| **bridge** | The **minimum** agreement rate across detected opinion groups |
| **commitment** | Weighted depth of pledged involvement — who will actually *do* something |
| **density** | How geographically concentrated the committed people are |
| **concreteness** | Is there a named target, a specific ask, and a deadline? |

Two decisions in there are doing all the work:

**Bridge takes the minimum, not the mean.** A mean lets the largest bloc drown a
dissenting group, so "consensus" collapses into "whatever the majority wanted" — the
exact dynamic this project exists to escape. A minimum means a proposal only scores when
even the least enthusiastic group is on board.

**Readiness is a geometric mean, so the factors are non-substitutable.** A zero anywhere
is a zero overall, and no amount of one factor buys its way past a missing one. The four
ways to score zero are all real failure modes:

- `bridge = 0` — only one faction wants it; it fractures on contact
- `commitment = 0` — everyone approves, nobody acts
- `density = 0` — supporters too scattered to be in one room
- `concreteness = 0` — no target, no ask, no date; nothing to organise toward

**The algorithm nominates; humans decide.** Crossing the readiness threshold never
auto-creates a campaign. It opens co-sponsorship, which takes real people.

## GraphRAG

The corpus of statements, campaigns and outcomes is indexed as an entity–relationship
graph with hierarchical community detection. This is not a chatbot bolted on; it serves
two things the relational tables cannot:

- **The learned taxonomy.** Clustering embeddings groups statements that *sound* alike.
  A graph groups statements that *share actors*. "Rezone the 5th St lot" and "the
  planning commission keeps deferring us" have almost no words in common and belong to
  the same cause — only the graph sees that.
- **The feedback loop.** *What has been tried against this target, and what happened?*
  is a graph traversal, and its answer is what should be on screen when someone picks a
  tactic.

Both the extractor and the summariser are pluggable, and **the defaults are
deterministic and offline**. A self-hosted instance must work with no API key and no
outbound network: an organising tool whose core feature phones a third party on every
statement is not a tool that the people who most need it can safely use. An LLM
extractor is an opt-in, not an assumption.

## Try it

No database and no Docker. Everything that needs persistence runs against real Postgres
compiled to WASM, in process, so this is the whole setup:

```bash
npm install && npm test
```

The interesting suite is the simulation harness. It generates synthetic populations with
*planted* opinion structure and checks the engine recovers it — including the load-bearing
case: two statements constructed to have **identical population-wide agreement**, one
broadly supported and one adored by a single faction. Any popularity-based scorer is
mathematically forced to call them equal. This one separates them on every seed.

```bash
npm run test:sim
```

## Design commitments

These are constraints, not preferences, and PRs that break them will be asked to change:

- **Coarse location only.** Precision-5 geohash (~5km) for people. Precise coordinates
  exist only for public events.
- **Self-hosting is first-class.** The default path requires no third-party account.
- **Scoring is inspectable.** Per-group breakdowns are shown, never hidden. A scoring
  system people cannot audit will be assumed rigged, and eventually will be.
- **Moderation ships with v1**, not after. Calls for violence, targeting private
  individuals, and doxxing are out.
- **No fine-grained reliability scores on people.** Attendance tracking stays coarse and
  aggregate; the alternative is a surveillance tool.
- **Lawful, nonviolent action only.** Petitions, public comment, rallies, canvassing,
  boycotts, mutual aid, tenant and labour organising, community projects.

## Self-hosting

An Instance runs with no third-party API keys and no outbound network, so it can be
hosted where the data must not leave. From a clean clone:

```bash
cp .env.example .env   # then change POSTGRES_PASSWORD
docker compose up
```

That starts Postgres and the Instance together. Migrations are applied on start, so
upgrading never means running database commands by hand, and the Region table is seeded
from the GeoNames extract vendored in `data/geonames/` — no network, no account.

### Root the vouching graph

Nobody can be promoted until at least one Participant is `verified`, so a fresh Instance
has one required step. Ask the person to sign in first — a Participant is created by
consuming a sign-in link, not by an operator conjuring one — then:

```bash
docker compose exec app npm run instance:verify -- you@example.org
```

Sign-in links are written to the app container's stdout (`docker compose logs -f app`)
until a mail transport is configured. Delivery sits behind an interface; the notification
system arrives with a later milestone.

Running `instance:verify` with no arguments lists who is already `verified`.

### What is running

Today the Instance is the database plus a background worker that applies migrations,
seeds Regions, and archives Conversations that attracted no Votes. There is no HTTP
server yet — serving deliberation over HTTP is M1's work, and standing up an unused
server now would be a surface to secure with nothing behind it.

## Roadmap

| | Milestone | Status |
|---|---|---|
| M2 | Discovery engine + simulation harness | **done** |
| — | GraphRAG index, communities, search, taxonomy | **done** |
| M0 | Postgres schema, Drizzle migrations, auth, Docker Compose | **done** |
| M1 | HTTP surface: sign-in, statement submission, vote UI | next |
| M3 | Cause dashboard, co-sponsorship, campaign promotion | |
| M4 | Campaign workspace, tactics, actions, roles, shifts, RSVP | |
| M5 | Check-in, outcome logging, tactic effectiveness | |
| M6 | Reports, moderation queue, know-your-rights surface | |

## Licence

[AGPL-3.0-or-later](LICENSE). Deliberately not MIT: AGPL closes the network-use
loophole, so a hosted fork cannot harvest organiser data without returning its changes.
For infrastructure handling political-association data, that is the right default.
