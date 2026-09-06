# GraphRAG over the organising corpus

## Why a graph and not just embeddings

The obvious way to build a "learned taxonomy" is to embed every statement and cluster the
vectors. We do not do that as the primary mechanism, because embedding similarity groups
statements that **sound alike**, and the thing we need to group is statements that are
**about the same fight**.

Consider two real statements:

> "We should get the planning commission to approve the rezoning for the 5th Street lot."

> "The planning commission keeps deferring our permit at every meeting."

These share almost no vocabulary and are not similar sentences. They are the same cause.
Cosine similarity will separate them; an entity graph puts them one hop apart, because
both mention the planning commission. That gap is the entire argument for this module.

There is a test asserting exactly this case in `tests/unit/graphrag.test.ts`
("connects statements that share an actor but no vocabulary").

## Pipeline

```
records ──▶ TextUnits ──▶ extract ──▶ graph ──▶ communities ──▶ reports ──▶ taxonomy
 (domain.ts)            (extract.ts) (graph.ts) (communities.ts) (summarize.ts) (taxonomy.ts)
```

**TextUnits** (`domain.ts`) are the adapter from app records. What we choose to feed the
graph determines what it can ever know, so this file is domain design, not plumbing.

Note that outcomes are written as *prose* containing the tactic, the target and the
result together in one unit. That is deliberate: co-occurrence within a unit is what
creates the edge, and splitting those three facts across units would silently break the
feedback loop while everything still appeared to work.

**Extraction** (`extract.ts`) is rule-based by default — domain lexicons for officials,
tactics, policies and resources, plus capitalised proper-noun runs, with co-occurrence
edges. Generic NER would happily extract "June" and "Tuesday"; what an organiser needs
found is the set of things that can be pressured, done, won, or spent.

**The default is deterministic and offline, and this is a security property, not a
performance trade-off.** An organising tool whose core indexing step sends every
statement to a third party is not a tool the people who most need it can safely use. An
LLM extractor implements the same `Extractor` interface and is opt-in.

**Entity merging** (`graph.ts`) folds surface variants that normalise identically. It does
**not** by default merge "city council" into "Austin City Council" — probably the same
body, but not across regions, and silent merging is the more dangerous default.
`resolveAliases()` will do it when asked, and only when the short form has exactly one
possible expansion; with both an Austin and a Dallas city council present it declines.

**Communities** (`communities.ts`) is Louvain with a connectivity repair pass. Plain
Louvain can leave a community whose members are not reachable from each other — the
defect that motivated the Leiden algorithm. Full Leiden is a lot of machinery; splitting
disconnected communities into their components buys the guarantee that matters here for a
fraction of the code, and it matters because a disconnected "cause" would be summarised as
one thing and shown to organisers as one thing while being two unrelated conversations.

The hierarchy is the point, not a side effect. Level 0 is specific enough to be a campaign
("the 5th St rezoning"); higher levels are broad enough to be a movement ("east side
housing supply").

**Summaries** (`summarize.ts`) are structural by default: which entities anchor the
community, which connections are strongest, how many sources back it. Plain on purpose —
an LLM summary that quietly editorialises about a political cause is a real hazard.

## The two queries

**`localSearch`** — *"What has been tried against the planning commission?"* Seeds on
entities the query names, walks 2 hops, returns the neighbourhood with source texts
attached. This is the evidence that should be on screen when someone chooses a tactic.

**`globalSearch`** — *"What are people actually organising around?"* Map-reduce over
pre-computed community reports rather than over passages. This question is a property of
the whole corpus, not of any passage in it, so top-k retrieval cannot answer it. Same
mechanism that produces the taxonomy.

Both return a **`ContextBundle`** — entities, relationships, source texts, reports, and a
rendered Markdown block — not prose. Answer generation is the caller's business. Keeping
that seam means retrieval stays fully testable with no model in the loop.

## Feedback loop

`tacticEvidence()` reads outcome units off the graph and aggregates win / partial /
refused / no-response per tactic, optionally filtered to a target.

It **refuses to report a success rate below a minimum sample** (default 3), returning
`null` instead. A confident-looking "100% success" from a single win would push organisers
toward whatever happened to be tried first, which is worse than admitting we do not know
yet.
