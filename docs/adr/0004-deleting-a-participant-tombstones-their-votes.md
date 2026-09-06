# Deleting a Participant tombstones their Votes rather than removing them

When a Participant deletes their account we hard-delete the person — every attribute,
every identifier, their location, their authored profile — but their Votes and
Commitments survive, reattached to an attribute-less tombstone that cannot be linked back
to them.

## Why

Fully deleting Votes retroactively rewrites other people's consensus. Every Bridge score
the departing Participant contributed to would shift, so a Cause could change tier, or
lose its `ready` status, because someone left months later. In a small Conversation the
effect is worse than untidy: removing one member of a three-person Opinion Group can
shrink it enough to make the remaining two identifiable, so honouring one person's
deletion can deanonymise others.

A Vote is a contribution to a shared artefact, not a possession. Withdrawing it silently
edits a collective record that other people relied on.

## Consequences

This is narrower than "hard delete" as ordinarily understood, so `SECURITY.md` states it
explicitly rather than promising more than we do. The tombstone must carry no attributes
whatsoever — no location, no verification level, no creation time — or it becomes a
correlation handle and defeats the point.
