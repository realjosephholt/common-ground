# Vouch revocation does not cascade

Two Vouches from `vouched`-or-better Participants promote a Participant to `vouched`.
Each Participant may hold at most five outstanding Vouches. Vouches are revocable. When
one is revoked, Participants that the demoted account had itself vouched for are **not**
demoted in turn.

## Why

Cascading revocation is the intuitive design and it is an attack surface. An adversary who
compromises one well-connected account could revoke its way through a Conversation,
mass-demoting participants below the entry gate and silencing them — a denial of service
wearing the costume of a safety feature. Since Verification Level gates who may take part
(ADR-0003), demotion is not a cosmetic change; it removes people from the conversation.

The five-Vouch cap bounds the blast radius of any single compromised account without
needing the cascade at all.

## Consequences

A ring of colluding accounts can leave verified accounts behind after the ring is caught,
which has to be cleaned up by moderation rather than automatically. That is the intended
trade: a slow manual cleanup beats a fast automated silencing tool.
