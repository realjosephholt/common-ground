# Promotion needs co-sponsors from two Opinion Groups, and enrols nobody automatically

Promoting a Statement to a Campaign is the moment discovery becomes organising, and two
things happen there deliberately. Co-sponsorship requires a quorum (5 by default, set per
Instance) whose members span **at least two Opinion Groups**. And the people who
registered a Commitment to that Statement are **not** enrolled in the resulting Campaign;
they receive an invitation.

## Why the cross-group requirement

Bridge is the minimum agreement across Opinion Groups, so a Statement can score highly on
the strength of a group that none of its promoters belong to. Without this rule, five
people from one faction can promote a Statement and then run a Campaign whose mandate
came from people they never spoke to. The requirement makes bridging structural rather
than advisory: the humans who carry a Statement forward must themselves cross the divide
the score claims exists.

## Why Commitment does not enrol

"I would turn up for a bike lane" is a low-stakes signal. Membership of a sustained
Campaign against a named Target, on a roster other members can see, is not. Silently
converting the first into the second manufactures precisely the artefact `SECURITY.md`
names as what an adversary wants: a membership list of people who never agreed to be on
one. A developer will reasonably assume the enrolment is a missing feature; it is not.

## Consequences

Campaigns start smaller than their Statement's Commitment count, and that gap is real
information rather than leakage to be plugged.
