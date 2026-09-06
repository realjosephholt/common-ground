# UUID keys and an origin_instance column, but no federation yet

Common Ground instances may eventually need to share Causes across deployments, so that
the same latent cause organising in three cities is visible as one. We are not building
federation now, but every table uses UUIDv7 primary keys and carries a nullable
`origin_instance` column from the first migration.

## Considered options

Local integer keys would be simpler and faster to read in logs. We rejected them because
retrofitting globally-unique identity across every table in a live database — while
preserving the vote matrix, the graph, and every foreign key — is precisely the migration
that never gets done, and the whole federation option would quietly die.

Building federation in v1 was rejected as a large distraction from getting a single
instance working end to end.

## Consequences

`origin_instance` is null on every row until federation exists. This will look like dead
weight to a future reader, which is why this file exists: it is deliberate, not an
abandoned feature. UUIDv7 rather than UUIDv4 so keys stay roughly time-ordered and index
locality does not collapse.
