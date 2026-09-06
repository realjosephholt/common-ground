# Statements survive Participant deletion; redaction is a logged moderation action

When a Participant deletes their account, Statements they authored remain, with
authorship stripped. Separately, an author may request **Redaction**, which removes the
Statement's text while leaving the Statement and its Votes in place, and writes an entry
to the Moderation Log.

## Why

This is deliberately not the same answer as ADR-0004, because it is not the same claim. A
Vote is a data point; a Statement is a person's words, and the case for erasing your own
speech is stronger than the case for erasing a vote. Against that: a Statement four
hundred people voted on cannot simply vanish, because those four hundred Votes become
meaningless — they are votes on nothing, still shaping the opinion map and every Bridge
score derived from it.

Redaction resolves the tension without a silent hole. The record keeps its shape, the
Votes keep their referent, the text goes, and the fact that it went is visible.

## Consequences

A redacted Statement still participates in scoring, which is intended — the Votes were
real. Redaction is logged rather than silent specifically so it cannot be used as a quiet
moderation channel that bypasses the Moderation Log.
