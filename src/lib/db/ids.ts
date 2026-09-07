/** UUIDv7 generation.
 *
 *  Written out rather than pulled in as a dependency, for the same reason as
 *  `discovery/geohash.ts`: it is thirty lines, and every dependency in a repo that
 *  handles political-association data is a supply-chain question someone has to answer.
 *
 *  v7 rather than v4 so keys stay roughly time-ordered and index locality does not
 *  collapse as an Instance grows (ADR-0002).
 */

let lastMs = 0;
let lastSeq = 0;

/**
 * A UUIDv7: 48 bits of Unix milliseconds, 4 version bits, 12 bits of sequence,
 * 2 variant bits, 62 bits of randomness.
 *
 * The 12-bit sequence counter is what makes two ids minted inside the same
 * millisecond still sort in creation order, which is the whole reason for choosing
 * v7. Without it a burst of inserts — exactly what a seed script or a busy
 * Conversation produces — would order randomly within each millisecond.
 */
export function uuidv7(now: number = Date.now()): string {
  const ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    lastSeq = (lastSeq + 1) & 0xfff;
    // Sequence exhausted inside one millisecond: borrow from the next one rather
    // than emit a non-monotonic id.
    if (lastSeq === 0) lastMs = ms + 1;
  } else {
    lastMs = ms;
    lastSeq = Math.floor(Math.random() * 0x1000);
  }

  const bytes = new Uint8Array(16);
  const t = lastMs;
  bytes[0] = Math.floor(t / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(t / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(t / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(t / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(t / 2 ** 8) & 0xff;
  bytes[5] = t & 0xff;

  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = 0x70 | ((lastSeq >> 8) & 0x0f);
  bytes[7] = lastSeq & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * An identifier with nothing in it.
 *
 * A tombstone keeps its primary key — that is the whole point of a tombstone — so the
 * key itself must carry no information. A UUIDv7 fails that test badly: its first 48
 * bits are the Unix millisecond it was minted at, so a retained v7 id hands back the
 * moment the deleted person signed up, exactly the correlation handle ADR-0004 forbids.
 * It slips past a check constraint on the other columns because the constraint cannot
 * see inside a key.
 *
 * So tombstoning rotates the id to a v4, which is 122 bits of randomness and nothing
 * else. That is a deliberate exception to ADR-0002's "UUIDv7 everywhere": v7 is there
 * for index locality as an Instance grows, and tombstones neither sort meaningfully nor
 * benefit from pretending to.
 */
export function uuidv4(): string {
  return crypto.randomUUID();
}
