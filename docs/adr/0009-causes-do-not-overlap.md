# A Statement belongs to exactly one Cause

Causes come from Louvain community detection, which produces a hard partition: every
Statement lands in exactly one Cause. We are keeping that, rather than moving to an
overlapping community algorithm.

## Why this needs recording

The limitation is real, not cosmetic. "Add a protected bus lane on Congress Ave" is
genuinely both a transit cause and a climate cause, and people arrive at it from both
directions. Someone will notice and reasonably propose overlapping communities.

We are declining for now because overlap makes promotion ambiguous. A Cause's readiness
is its Spearhead's (ADR-0001), so a Statement sitting in two Causes can be Spearhead of
both, and "promote this Cause" stops having one answer. That ambiguity would land in the
most consequential transition in the product.

The hierarchy carries the relatedness instead: a bus-lane Cause and a bike-lane Cause
sharing a parent community says "these are related" without claiming they are the same
fight. That is the more honest statement anyway.

## Consequences

A Statement's Cause can change between re-indexes as the graph grows, which is the
subject of ADR-0010.
