# Causes are persisted entities, reconciled across re-indexes

A Cause is stored with its own stable UUID rather than being recomputed from scratch each
time the graph is indexed. Re-indexing runs a reconciliation step: each newly detected
community is matched against existing Causes by membership overlap (Jaccard over member
Statements, above a threshold); a match inherits the existing Cause's identity and label;
an unmatched community mints a new Cause; a Cause whose members have dispersed is marked
dormant rather than deleted.

## The bug this fixes

Community identifiers out of Louvain are positional — `c{level}-{index}` — and the index
is assigned by iteration order over the entity set. That is deterministic for a fixed
graph and **unstable the moment the corpus grows**. `buildTaxonomy()` accepts
`humanLabels` keyed by exactly that identifier, so the first re-index after someone names
a Cause would silently reattach their label to a different Cause. Nothing would error.

ADR-0001 made this considerably worse by promoting the Cause to the unit people organise
around: once Campaign provenance and Outcome traceability hang off a Cause, an identifier
that quietly changes meaning is not a cosmetic problem.

## Considered options

Keeping Causes ephemeral and never referencing them from anything persistent would have
worked, but discards the labels, provenance and traceability that ADR-0001 requires.

Freezing a Cause's membership once labelled was rejected because it stops the taxonomy
learning at precisely the moment someone cares about it, which defeats the purpose of
deriving it from the graph rather than curating it.

## Consequences

Real cost: a reconciliation pass, a similarity threshold that needs tuning against real
data, and a dormant state to reason about. Accepted because the alternative is a system
that renames people's causes behind their backs.
