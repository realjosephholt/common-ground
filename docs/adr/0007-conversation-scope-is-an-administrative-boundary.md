# A Conversation is scoped to an administrative boundary, not a geohash prefix

Conversations declare their scope as a named administrative Region — a county, city,
district or ward — referenced by a stable external identifier. Geohashes remain in use
internally for Density scoring, but never to define scope.

## Why

Concreteness requires a Target with jurisdiction over the ask, and jurisdictions follow
administrative boundaries. A geohash cell straddling two counties names nobody who can
grant anything, so a Conversation scoped that way is structurally incapable of producing
a concrete proposal.

There is also a plainer reason: people organise around places that have names. "Travis
County" is something you can say out loud at a meeting; `9v6kp` is not.

## A correction to the reasoning above

"Targets hold jurisdiction over administrative areas" is tighter than the truth. An
elected official's authority runs over their *electoral district*, and congressional
districts, state legislative districts and their equivalents coincide with no
administrative unit and appear in none of the available boundary datasets.

This does not change the decision, because a Conversation's scope and a Target's
Jurisdiction do not have to match: a county-scoped Conversation can target a
congressperson perfectly well. It does change the model. A Target's Jurisdiction is a
name plus an *optional* Region link, so "TX-35" can be recorded without a dataset that
contains it. Electoral geography is published differently in every country and mostly
badly; adopting it would multiply the dataset problem for no v1 benefit.

## Consequences

Two different location concepts now coexist — administrative Regions for scope, geohashes
for Density — and a reader will wonder whether that is an accident. It is not. A third,
Jurisdiction, is deliberately not a geography at all.
