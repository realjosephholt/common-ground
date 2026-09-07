import { decodeGeohash, haversineKm, type LatLng } from "./geohash";

export interface DensityResult {
  /** share of committed weight inside the densest cluster, in [0,1] */
  score: number;
  /** centre of the densest cluster — where the action would actually happen */
  centre: LatLng | null;
  /** committed weight inside that cluster */
  clusterWeight: number;
  totalWeight: number;
  /** distinct people inside the densest cluster */
  clusterPeople: number;
}

export interface CommittedPerson {
  userId: string;
  geohash5: string;
  weight: number;
}

export interface DensityOptions {
  /** Cluster radius in km. Default 15 — roughly "people who could plausibly turn
   *  up at the same place on the same afternoon without staying overnight". */
  radiusKm?: number;
}

/**
 * Geographic concentration of commitment.
 *
 * Ten committed people in one city are worth more than a thousand scattered across
 * a continent, and this is the factor mainstream petition platforms omit entirely —
 * which is why a petition with 400,000 signatures routinely produces a rally of nine.
 *
 * Implemented as greedy max-weight clustering on decoded cell centres rather than by
 * grouping on the geohash string. Grouping on the string looks simpler but is wrong:
 * two people 200m apart can straddle a cell boundary and land in different buckets,
 * so a genuinely concentrated group can be scored as diffuse. Decoding to coordinates
 * and clustering by true distance has no boundary artefacts.
 */
export function densityScore(people: readonly CommittedPerson[], opts: DensityOptions = {}): DensityResult {
  const radiusKm = opts.radiusKm ?? 15;
  const totalWeight = people.reduce((a, p) => a + p.weight, 0);
  if (people.length === 0 || totalWeight <= 0) {
    return { score: 0, centre: null, clusterWeight: 0, totalWeight: 0, clusterPeople: 0 };
  }

  const pts = people.map((p) => ({ ...p, at: decodeGeohash(p.geohash5) }));

  let bestWeight = -1;
  let bestCentre: LatLng | null = null;
  let bestPeople = 0;

  // Every person's location is a candidate cluster centre. O(n²) is fine at the scale
  // where this matters; if a single statement ever draws >10k committed people we can
  // pre-bucket by geohash prefix before this step.
  for (const anchor of pts) {
    let w = 0;
    let count = 0;
    for (const other of pts) {
      if (haversineKm(anchor.at, other.at) <= radiusKm) {
        w += other.weight;
        count++;
      }
    }
    if (w > bestWeight) {
      bestWeight = w;
      bestCentre = anchor.at;
      bestPeople = count;
    }
  }

  return {
    score: bestWeight / totalWeight,
    centre: bestCentre,
    clusterWeight: bestWeight,
    totalWeight,
    clusterPeople: bestPeople,
  };
}
