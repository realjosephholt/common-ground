import type { VoteMatrixLike } from "./pca";
import type { VoteRecord, VoteValue } from "./types";

/** Users x statements. `null` means "this user never saw this statement", which is
 *  categorically different from "saw it and passed" (0). Keeping them distinct is
 *  what lets the routing layer reason about exposure. */
export interface VoteMatrix {
  userIds: string[];
  statementIds: string[];
  values: (VoteValue | null)[][];
  userIndex: Map<string, number>;
  statementIndex: Map<string, number>;
}

export function buildVoteMatrix(votes: readonly VoteRecord[]): VoteMatrix {
  const userIds: string[] = [];
  const statementIds: string[] = [];
  const userIndex = new Map<string, number>();
  const statementIndex = new Map<string, number>();

  for (const v of votes) {
    if (!userIndex.has(v.userId)) {
      userIndex.set(v.userId, userIds.length);
      userIds.push(v.userId);
    }
    if (!statementIndex.has(v.statementId)) {
      statementIndex.set(v.statementId, statementIds.length);
      statementIds.push(v.statementId);
    }
  }

  const values: (VoteValue | null)[][] = Array.from({ length: userIds.length }, () =>
    new Array<VoteValue | null>(statementIds.length).fill(null),
  );

  for (const v of votes) {
    const r = userIndex.get(v.userId)!;
    const c = statementIndex.get(v.statementId)!;
    values[r]![c] = v.value;
  }

  return { userIds, statementIds, values, userIndex, statementIndex };
}

/**
 * Mean-impute then mean-center each statement column.
 *
 * Unseen entries become the column mean, so after centering they are exactly 0 —
 * i.e. an unseen statement pulls a user toward the origin rather than inventing a
 * disagreement. This is the standard treatment and it matters: naively imputing
 * -1 or 0 *before* centering would make sparse voters look like a distinct
 * opinion group, which is the single easiest way to get garbage clusters.
 */
export function toCenteredMatrix(m: VoteMatrix): VoteMatrixLike {
  const rows = m.values.length;
  const cols = m.statementIds.length;
  const out: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let c = 0; c < cols; c++) {
    let sum = 0;
    let seen = 0;
    for (let r = 0; r < rows; r++) {
      const v = m.values[r]![c] ?? null;
      if (v !== null) {
        sum += v;
        seen++;
      }
    }
    const mean = seen > 0 ? sum / seen : 0;
    for (let r = 0; r < rows; r++) {
      const v = m.values[r]![c] ?? null;
      out[r]![c] = v === null ? 0 : v - mean;
    }
  }
  return out;
}

/** Number of distinct users who have seen (voted on) a statement. */
export function exposureCounts(m: VoteMatrix): Map<string, number> {
  const out = new Map<string, number>();
  for (let c = 0; c < m.statementIds.length; c++) {
    let n = 0;
    for (let r = 0; r < m.values.length; r++) if (m.values[r]![c] !== null) n++;
    out.set(m.statementIds[c]!, n);
  }
  return out;
}
