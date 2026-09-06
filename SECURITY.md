# Security & threat model

## Reporting a vulnerability

Use a **private security advisory** on this repository. Do not open a public issue.
Assume adversaries read this repo.

## Who this software has to protect

Common Ground handles political-association data: who supports what, who is willing to
act, and roughly where they are. That is exactly the data that gets people fired,
evicted, deported, or arrested. The threat model is therefore not "a startup losing
customer records" — it is "an adversary with subpoena power, or a hostile employer, or a
motivated harasser, wanting a membership list."

## Design decisions that follow from that

| Decision | Reason |
|---|---|
| Coarse geohash (precision 5, ~5km) for people; never precise coordinates | A precise home location is the single most dangerous field we could hold. Density scoring works fine at 5km. |
| Precise location only on **public** events | An announced rally is already public. A person's home is not. |
| No real-name requirement | Pseudonymous participation is the default, not a concession. |
| Attendance tracking stays coarse and aggregate | Per-person reliability scores would make this a surveillance tool. The feature is deliberately less useful than it could be. |
| No third-party analytics | Every embedded tracker is an off-site copy of who is organising for what. |
| Any `vouched` Participant may open a Conversation; creation is not moderator-gated | Restricting who may open a Conversation would make the operator the gatekeeper of what can be discussed — the censorship surface relocated, not removed. Spam is handled by rate limits and auto-archival of Conversations with no Votes after 14 days. |
| Notifications only for things a Participant already has a stake in — never "a new Cause appeared near you" | An unsolicited political notification on a lock screen can be read by a partner, parent, or employer. Proximity-based engagement features are how a tool like this gets someone hurt. |
| Deterministic, offline defaults for extraction and scoring | An instance must be runnable with no outbound network at all. |
| Self-hosting is first-class | Some users cannot put this data on someone else's infrastructure, in someone else's jurisdiction. |
| Data export, and deletion that erases the person but tombstones their Votes | Leaving must be possible. Erasing Votes too would retroactively rewrite other people's consensus and can deanonymise the remaining members of a small Opinion Group. See [ADR-0004](docs/adr/0004-deleting-a-participant-tombstones-their-votes.md). |

## Known open problems

These are real and not yet solved. Do not assume otherwise.

1. **Sybil resistance is the central unsolved threat.** If accounts are free, "shared
   support" is meaningless and campaigns can be astroturfed. The mitigation is
   verification tiers plus a capped vouching graph, used to **gate entry** to a
   conversation. Vote weighting was considered and rejected — it would silently distort
   the opinion clustering that every readiness score depends on, and we cannot yet test
   that it helps more than it harms. See
   [ADR-0003](docs/adr/0003-verification-level-does-not-weight-votes.md). None of it is
   implemented yet, and none of it is sufficient against a determined, resourced
   adversary.
2. **Metadata leaks even with coarse location.** A small conversation in a small region
   can identify people through participation patterns alone. Differential-privacy
   treatment of published aggregates is not designed yet.
3. **Brigading detection is dual-use.** The same signals that catch coordinated
   inauthentic voting can flag a genuine grassroots surge. Detection must flag for human
   review and must never auto-ban.
4. **Moderation is a censorship surface.** Whoever moderates can suppress causes. The
   mitigation is a public, append-only Moderation Log recording actor, action, target,
   reason and timestamp for every moderation action. Decided, not yet built.
5. **Server operators can see everything.** There is no end-to-end encryption. A hostile
   or compromised instance operator has full access. Choose whose instance you join
   accordingly.

## Scope

In scope: authentication, authorisation, injection, data exposure, deanonymisation,
scoring manipulation, and anything that leaks participation data.

Out of scope: attacks needing physical access to the server, and social engineering of
users outside the application.
