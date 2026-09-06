# The scoring algorithm

Written for a sceptical reader. If you think this system is biased against your cause,
this document should let you check.

Everything here is implemented in `src/lib/discovery/` as pure functions with no
database access, and exercised by `tests/simulation/`.

---

## 1. Opinion groups

**Input:** every vote in a conversation, as (user, statement) → agree / disagree / pass.

1. **Build a matrix** of users × statements. An entry is `null` if that user never saw
   that statement — categorically different from seeing it and passing.
2. **Mean-impute and centre each column.** Unseen entries become the column mean, so
   after centring they are exactly 0. Naively imputing a constant *before* centring
   would make sparse voters look like their own opinion group — the easiest way to get
   garbage clusters.
3. **PCA to two components** by power iteration with deflation. Two, not more, because
   the output is a map a human has to read.
4. **k-means, with k chosen by silhouette over k ∈ [2,5].** k is capped low on purpose:
   eight opinion groups is not a divide anyone can reason about, and it would make the
   minimum in step 2 below hostage to a tiny splinter cluster.

Fewer than 4 participants: everyone is treated as one group. The prior in the next step
keeps the resulting scores appropriately unconfident.

**Verified by:** `tests/simulation/engine.test.ts` recovers planted groups at
ARI > 0.9 for both 2-group and 3-group populations.

## 2. Bridge — the minimum agreement across groups

Agreement for one statement within one group is the mean of a Beta(1,1) posterior:

```
p = (agree + 1) / (agree + disagree + pass + 2)
```

The prior does two jobs:

- It stops a tiny unanimous sample beating a large strong one. 2-of-2 smooths to 0.75;
  90-of-100 smooths to 0.89.
- **A group that has never seen the statement scores exactly 0.5.** Combined with the
  minimum below, this caps a statement's bridge score at 0.5 until every group has
  actually been exposed to it. Unexposed is not the same as agreed.

A `pass` counts against agreement by default. On a *proposal*, "I'd rather not say" is
not support, and treating passes as neutral floats vague feel-good statements to the top.

```
bridge = min over groups of p
```

**Minimum, not mean.** This is the single most important line in the codebase. A mean
lets a large bloc drown a dissenting group, so "consensus" degenerates into "whatever
the biggest group wants". A minimum means even the least enthusiastic group must be on
board — which is also the honest predictor of whether an action survives opposition.

**Verified by:** the fixture plants two statements with *identical* population-wide
agreement — one supported by 75% of every group, one adored by group 0 and tolerated by
the rest. Any popularity-based scorer must call them equal. The bridging score separates
them on every seed tested.

## 3. Commitment — depth of pledged involvement

Pledges are weighted by scarcity, not enthusiasm:

| Pledge | Weight |
|---|---|
| support | 1 |
| fund | 1 |
| show up | 3 |
| offer a skill | 4 |
| organise | 6 |

Only a person's strongest pledge counts. Then:

```
commitment = raw / (raw + K)      K = 30 by default
```

A saturating curve on the **absolute** weighted total, not a rate. Whether an action is
feasible depends on absolute numbers: twenty people who will show up can run a rally
whether twenty or twenty thousand saw the proposal. Dividing by exposure would penalise a
proposal for reaching more people.

The exposure-relative rate is still computed and shown on the dashboard as
`conversion` — a proposal with high raw commitment but 2% conversion is a different
animal from one at 40% — but it does not move the score.

## 4. Density — geographic concentration

Ten committed people in one city beat a thousand scattered across a continent. This is
the factor mainstream petition platforms omit entirely, which is why a petition with
400,000 signatures routinely produces a rally of nine.

Committed people's coarse cells are decoded to coordinates and greedily clustered by true
distance (default radius 15 km ≈ "could plausibly be in the same place on the same
afternoon"). The score is the share of committed *weight* inside the densest cluster.

Clustering on the geohash string would be simpler and wrong: two people 200 m apart can
straddle a cell boundary, so a concentrated group can be scored as diffuse.

## 5. Concreteness — is there anything to organise toward?

Three binary signals: a named **target** who could grant the ask, a **specific ask**, and
a **deadline**. Score is `raw / 3`.

The default extractor is regex-based, dependency-free and offline. That is the default
rather than a fallback for two reasons: a self-hosted instance must work with no API key,
and a model deciding on its own that a proposal is "not concrete enough" is a censorship
surface with plausible deniability. A model may *suggest*; a human confirmation always
wins.

## 6. Readiness

```
readiness = (bridge · commitment · density · concreteness) ^ (1/4)
```

The geometric mean makes the factors **non-substitutable**: a zero anywhere is a zero
overall. An arithmetic mean would let 100% agreement plus zero commitment score 0.5 and
look halfway to happening — the exact false signal this project exists to remove.

Tiers: `latent` < 0.25 ≤ `emerging` < 0.5 ≤ `ready`.

The dashboard always shows the **limiting factor**, because "you have agreement and
people, you have no target" is actionable and a bare 0.31 is not.

**Reaching `ready` does not create a campaign.** It opens co-sponsorship, which requires
real humans. The algorithm nominates; people decide.

## 7. Routing — which statement you see next

Looks like a UI detail; it decides which cells of the vote matrix ever get filled.

```
priority = 1·infoGain + 1.2·crossGroup + 0.5·freshness
```

- `infoGain = 1/√(votes+1)` — attention is the scarcest input; spending it on a
  statement with 400 votes buys almost nothing.
- `crossGroup` — the highest agreement among groups the user is **not** in. Deliberate
  exposure to what the other side likes, because that is where bridges are found.
  Relevance-ranked routing would manufacture the exact echo chamber the bridging score
  exists to detect, and would do it invisibly.
- `freshness` — a 7-day decaying bonus so new statements escape the cold start.

Selection is softmax-sampled, not argmax, so a hundred simultaneous voters do not all
get handed the same statement.

## Manipulation resistance — and its limits

Implemented: the Beta prior blunts small-sample gaming; the minimum across groups means
buying one faction does not buy the score; commitment saturates so volume alone stops
helping; per-group breakdowns are always public.

**Not yet implemented, and load-bearing:** Sybil resistance. If accounts are free, all of
the above can be defeated by making enough accounts. See [SECURITY.md](../SECURITY.md).
