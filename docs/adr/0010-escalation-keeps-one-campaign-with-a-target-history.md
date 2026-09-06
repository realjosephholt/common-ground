# Escalation keeps one Campaign and records a Target history

A Campaign has exactly one *active* Target at a time, but retains the ordered history of
every Target it has escalated through, with the Outcome recorded against each. Escalating
does not create a new Campaign.

## Why

Escalation is the ordinary shape of organising: ask the department, get nowhere, go to
the elected official who oversees it. Modelling that as "close this Campaign, open
another" would shatter exactly the history the feedback loop exists to accumulate.

`tacticEvidence()` is built to answer "what has been tried against the planning
commission, and what happened". The follow-up question — "and what happened when we went
over their head?" — is unanswerable if the escalation is an unlinked row. Since improving
Tactic selection from real Outcomes is the whole point of closing the loop, severing the
link would quietly disable the feature while everything still appeared to work.

## Consequences

Outcomes are keyed to a (Campaign, Target) pair rather than to a Campaign, so a
Campaign's overall result is a sequence rather than a single verdict. That is a fair
description of how these things actually end.
