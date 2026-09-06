/** Core value types for the discovery engine. Kept free of DB/ORM imports so the
 *  whole pipeline can be driven directly by the simulation harness. */

/** disagree | pass | agree */
export type VoteValue = -1 | 0 | 1;

export type CommitmentLevel = "support" | "fund" | "show_up" | "skill" | "organize";

export type VerificationLevel = "anonymous" | "email" | "vouched" | "verified";

export type ReadinessTier = "latent" | "emerging" | "ready";

export interface VoteRecord {
  userId: string;
  statementId: string;
  value: VoteValue;
}

export interface CommitmentRecord {
  userId: string;
  statementId: string;
  level: CommitmentLevel;
}

/** Coarse location only. We never store precise coordinates for a person. */
export interface CoarseLocation {
  /** geohash, precision 5 (~4.9km x 4.9km) */
  geohash5: string;
}

export interface GroupVoteTally {
  agree: number;
  disagree: number;
  pass: number;
}

export interface ReadinessFactors {
  bridge: number;
  commitment: number;
  density: number;
  concreteness: number;
}

export interface StatementScore {
  statementId: string;
  factors: ReadinessFactors;
  readiness: number;
  tier: ReadinessTier;
  /** per-opinion-group agreement rates, index-aligned with opinion groups */
  perGroupAgreement: number[];
  /** diagnostics surfaced in the UI but deliberately NOT part of the score */
  diagnostics: {
    totalVotes: number;
    rawAgreementRate: number;
    exposure: number;
    commitmentConversion: number;
    committedPeople: number;
  };
}
