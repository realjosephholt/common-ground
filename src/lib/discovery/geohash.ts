/** Minimal geohash decoder. Written out rather than pulled in as a dependency:
 *  it is ~40 lines, and every dependency in a repo that handles political-association
 *  data is a supply-chain question someone has to answer. */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface LatLng {
  lat: number;
  lng: number;
}

/** Decode a geohash to the centre of its cell. */
export function decodeGeohash(hash: string): LatLng {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let isLng = true;

  for (const ch of hash.toLowerCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    for (let bit = 4; bit >= 0; bit--) {
      const bitVal = (idx >> bit) & 1;
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if (bitVal === 1) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bitVal === 1) latMin = mid;
        else latMax = mid;
      }
      isLng = !isLng;
    }
  }
  return { lat: (latMin + latMax) / 2, lng: (lngMin + lngMax) / 2 };
}

export function encodeGeohash(lat: number, lng: number, precision = 5): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let isLng = true;
  let bit = 0;
  let idx = 0;
  let out = "";

  while (out.length < precision) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng > mid) {
        idx = (idx << 1) + 1;
        lngMin = mid;
      } else {
        idx = idx << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) {
        idx = (idx << 1) + 1;
        latMin = mid;
      } else {
        idx = idx << 1;
        latMax = mid;
      }
    }
    isLng = !isLng;
    if (++bit === 5) {
      out += BASE32[idx]!;
      bit = 0;
      idx = 0;
    }
  }
  return out;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}
