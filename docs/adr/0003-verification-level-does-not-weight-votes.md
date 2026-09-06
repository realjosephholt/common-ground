# Verification Level gates entry; it never weights a Vote

Sybil resistance is the central unsolved threat to this system: if accounts are free,
"shared support" is meaningless. The obvious defence is to weight votes by how well
verified a Participant is. We are not doing that. Verification Level gates entry to a
Conversation and is published as composition data; every Vote inside a Conversation
counts the same.

## Why

Weighting distorts the discovery maths in a way that is invisible from the outside. The
opinion map comes from PCA over the vote matrix followed by k-means; weighting rows
changes the principal components and therefore changes **which Opinion Groups exist at
all**. Since Bridge is the minimum across those groups, a weighting constant chosen for
anti-abuse reasons would silently move every readiness score in the system, and the
simulation harness currently has no way to plant a Sybil attack and demonstrate the
weighting helps more than it distorts.

A gate is also more honest. "You must be vouched to vote here" is legible and
contestable; "your vote counted 0.4" is neither.

## Consequences

`verification_level` and the vouching graph exist in the schema and are enforced at the
Conversation boundary, but nothing in `src/lib/discovery/` reads them. Someone will
eventually notice that and try to wire it into the scoring — that would be a regression
unless the harness can first show it is safe. Revisit when the harness can generate
adversarial populations.
