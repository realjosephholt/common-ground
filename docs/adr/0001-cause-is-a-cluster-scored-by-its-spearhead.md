# A Cause is a graph cluster, scored by its strongest Statement

The scoring engine scores individual Statements, while the knowledge graph discovers
clusters of Statements that share actors and targets. We had to decide which of those a
"Cause" is. We defined a Cause as the cluster, and its readiness as the readiness of its
single highest-scoring member — the Spearhead — rather than any aggregate over members.

## Considered options

Making a Cause merely a label for a high-scoring Statement would have left the learned
taxonomy decorative: the graph would organise navigation and nothing else.

Making a Cause a first-class entity with its own aggregated readiness is the
intellectually cleaner answer, and we rejected it for now because the aggregation is not
obvious and not yet testable. Bridge over a cluster is emphatically **not** the mean of
its members' bridge scores — opinion groups are defined per Conversation, members can
span Conversations, and a cluster containing one unifying and one polarising Statement
has no defensible single agreement rate. Inventing that maths without the simulation
harness being able to validate it would mean shipping a number nobody could defend.

## Consequences

`max` is a real claim, not a placeholder: people organise around a specific ask, not a
theme, so a Cause is exactly as actionable as its most actionable Statement. The
simulation harness continues to validate the scoring unchanged, because nothing about
per-Statement scoring moves. Revisit if and when the harness can plant cluster-level
structure and check a group-level score recovers it.

Because readiness is delegated to a single member, losing that member moves the Cause's
headline number. When a Spearhead is redacted or removed by moderation, readiness
recomputes to the next-best Statement and the change is shown on the Cause rather than
applied silently. A Cause survives as long as it retains one Statement. Critically, a
Spearhead change **never retracts a Campaign that was already promoted**: a Campaign is a
commitment people made to each other, and it does not evaporate because the Statement
that spawned it was later removed.
