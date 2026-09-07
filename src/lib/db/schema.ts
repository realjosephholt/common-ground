/**
 * The M0 schema: persistence, identity, and the discovery data model.
 *
 * `CONTEXT.md` is the naming authority here — Participant rather than User, Statement
 * rather than Proposal. Where a decision recorded in `docs/adr/` can be expressed as a
 * constraint it is expressed as a constraint, because an invariant enforced only by the
 * service layer becomes folklore the moment someone writes a second service.
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { CommitmentLevel } from "../discovery/types";

export type ConversationStatus = "open" | "closed" | "archived";
export type ModerationStatus = "approved" | "pending" | "removed";
export type ReportStatus = "open" | "resolved" | "dismissed";
/** Only the levels the vendored extract's format can actually carry. Deeper levels —
 *  wards, communes — need an extract format that records their codes, so adding one to
 *  this list without doing that would silently mis-parent every row at that level. */
export type RegionLevel = (typeof REGION_LEVELS)[number];

/** Weakest to strongest. Used as a gate at the Conversation boundary and nowhere
 *  else — nothing in `src/lib/discovery/` may read a Verification Level (ADR-0003). */
export const VERIFICATION_LEVELS = ["anonymous", "email", "vouched", "verified"] as const;

/** Declared here rather than alongside the scoring types, so that nothing in
 *  `src/lib/discovery/` so much as names it. ADR-0003 says the scoring path may not
 *  read a Verification Level; keeping the vocabulary out of that module is what lets
 *  `tests/unit/architecture.test.ts` check the claim with no exceptions to argue about. */
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
export const COMMITMENT_LEVELS = ["support", "fund", "show_up", "skill", "organize"] as const;
export const CONVERSATION_STATUSES = ["open", "closed", "archived"] as const;
export const MODERATION_STATUSES = ["approved", "pending", "removed"] as const;
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export const REGION_LEVELS = ["country", "admin1", "admin2"] as const;

/** Every action that can be written to the Moderation Log. Closed rather than free
 *  text: a log whose vocabulary drifts cannot be read consistently by whoever audits
 *  it years later, which is the only reason the log exists. */
export const MODERATION_ACTIONS = [
  "statement_removed",
  "statement_restored",
  "statement_redacted",
  "report_resolved",
  "report_dismissed",
] as const;
export const MODERATION_SUBJECT_TYPES = ["statement", "report"] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
export type ModerationSubjectType = (typeof MODERATION_SUBJECT_TYPES)[number];

const inList = (column: string, values: readonly string[]): ReturnType<typeof sql> =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);

/** Present on every table and null on every row until federation exists (ADR-0002).
 *  This is deliberate dead weight, not an abandoned feature. Note that `participants`
 *  nulls it on tombstoning: in a federated world it would narrow a deleted person to
 *  one Instance, which is precisely the kind of correlation handle ADR-0004 forbids. */
const originInstance = () => uuid("origin_instance");

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

/** One deployment's settings. Constrained to a single row: an Instance that disagreed
 *  with itself about its own entry gate would be unauditable. */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    singleton: boolean("singleton").notNull().default(true),
    name: text("name").notNull(),
    /** Default gate applied to new Conversations; an operator may raise it per-Conversation. */
    defaultMinVerificationLevel: text("default_min_verification_level")
      .$type<VerificationLevel>()
      .notNull()
      .default("vouched"),
    /** A Conversation with no Votes after this many days is archived automatically. */
    archiveSilentConversationsAfterDays: integer("archive_silent_conversations_after_days")
      .notNull()
      .default(14),
    /** Conversations one Participant may open within `rateLimitWindowHours`. */
    conversationRateLimit: integer("conversation_rate_limit").notNull().default(3),
    conversationRateLimitWindowHours: integer("conversation_rate_limit_window_hours")
      .notNull()
      .default(24),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instance_settings_singleton").on(t.singleton),
    check("instance_settings_singleton_true", sql`${t.singleton} is true`),
    check("instance_settings_default_level", inList("default_min_verification_level", VERIFICATION_LEVELS)),
  ],
);

// ---------------------------------------------------------------------------
// Region (ADR-0007, ADR-0012)
// ---------------------------------------------------------------------------

/** Keyed on GeoNames' `geonameId` and never on the concatenated administrative codes
 *  (`US.CA.001`), which are country-specific and get restructured (ADR-0012). This is
 *  the one table that does not take a UUID key, because its identity is external. */
export const regions = pgTable(
  "regions",
  {
    geonameId: integer("geoname_id").primaryKey(),
    originInstance: originInstance(),
    name: text("name").notNull(),
    asciiName: text("ascii_name").notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    level: text("level").$type<RegionLevel>().notNull(),
    parentId: integer("parent_id").references((): AnyPgColumn => regions.geonameId, {
      onDelete: "set null",
    }),
    /** Retained for seeding and reconciliation only. Never a key. */
    admin1Code: text("admin1_code"),
    admin2Code: text("admin2_code"),
    /** The vendored extract this row came from, so a version bump is detectable. */
    datasetVersion: text("dataset_version").notNull(),
  },
  (t) => [
    check("regions_level", inList("level", REGION_LEVELS)),
    index("regions_ascii_name").on(t.asciiName),
    index("regions_parent").on(t.parentId),
  ],
);

// ---------------------------------------------------------------------------
// Participant (ADR-0004)
// ---------------------------------------------------------------------------

/**
 * A Participant, or — once deleted — a tombstone.
 *
 * Every attribute is nullable, which looks like sloppy modelling and is not. Deleting a
 * Participant erases *every* attribute and leaves a row retaining only the identifier
 * other tables point at (ADR-0004). The tombstone must carry no attributes whatsoever —
 * not a location, not a Verification Level, not even a creation time — or it becomes a
 * correlation handle and defeats its own purpose.
 *
 * The `participants_tombstone_is_empty` check is what stops that decaying into folklore:
 * a live Participant must have its required attributes, and a tombstone must have none.
 *
 * The check cannot see the one column that has to survive, though. A UUIDv7 carries 48
 * bits of Unix milliseconds, so a retained `id` would hand back the sign-up time to the
 * millisecond — an attribute smuggled through the primary key, past a constraint that
 * only inspects the other columns. So tombstoning rotates the id to a time-free one,
 * which is why every foreign key here cascades on update.
 */
export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    email: text("email"),
    /** Chosen by the Participant. A real name is never requested. */
    displayName: text("display_name"),
    /** Coarse location only, precision 5 (~4.9km x 4.9km). Precise coordinates are
     *  never stored for a person. */
    geohash5: char("geohash5", { length: 5 }),
    /** Optional home Region. Separate from `geohash5` on purpose: Region scopes
     *  Conversations, geohash feeds Density (ADR-0007). */
    regionId: integer("region_id").references(() => regions.geonameId, { onDelete: "set null" }),
    verificationLevel: text("verification_level").$type<VerificationLevel>(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    /** The only attribute a tombstone carries, and it distinguishes no tombstone from
     *  any other, so it is not a correlation handle. */
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => [
    uniqueIndex("participants_email").on(t.email),
    check("participants_level", sql`${t.verificationLevel} is null or ${inList("verification_level", VERIFICATION_LEVELS)}`),
    check("participants_geohash5_precision", sql`${t.geohash5} is null or length(${t.geohash5}) = 5`),
    check(
      "participants_tombstone_is_empty",
      sql`(
        ${t.tombstoned} = false
        and ${t.email} is not null
        and ${t.displayName} is not null
        and ${t.verificationLevel} is not null
        and ${t.createdAt} is not null
      ) or (
        ${t.tombstoned} = true
        and ${t.originInstance} is null
        and ${t.email} is null
        and ${t.displayName} is null
        and ${t.geohash5} is null
        and ${t.regionId} is null
        and ${t.verificationLevel} is null
        and ${t.createdAt} is null
        and ${t.updatedAt} is null
      )`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** A single-use, short-lived sign-in link. Only the hash of the token is stored, so a
 *  database leak does not hand an attacker a set of working sign-in links. */
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    email: text("email").notNull(),
    /** Held here rather than on `participants` so an unconsumed link creates no account. */
    displayName: text("display_name"),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("magic_link_tokens_hash").on(t.tokenHash), index("magic_link_tokens_email").on(t.email)],
);

/** Sessions are not a shared artefact, so they are deleted outright with the
 *  Participant rather than tombstoned. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("sessions_hash").on(t.tokenHash), index("sessions_participant").on(t.participantId)],
);

// ---------------------------------------------------------------------------
// Vouching (ADR-0008)
// ---------------------------------------------------------------------------

/** A revocable edge. Revocation sets a timestamp rather than deleting the row, so the
 *  history of who attested to whom survives the revocation (ADR-0008). */
export const vouches = pgTable(
  "vouches",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    voucherId: uuid("voucher_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade", onUpdate: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("vouches_not_self", sql`${t.voucherId} <> ${t.subjectId}`),
    uniqueIndex("vouches_live_pair").on(t.voucherId, t.subjectId).where(sql`revoked_at is null`),
    index("vouches_subject").on(t.subjectId),
  ],
);

// ---------------------------------------------------------------------------
// Deliberation
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    /** Scope is an administrative boundary, never a geohash prefix (ADR-0007). */
    regionId: integer("region_id")
      .notNull()
      .references(() => regions.geonameId, { onDelete: "restrict" }),
    seedTopic: text("seed_topic").notNull(),
    /** Points at the tombstone once the opener deletes their account. */
    createdBy: uuid("created_by").references(() => participants.id, { onDelete: "set null", onUpdate: "cascade" }),
    status: text("status").$type<ConversationStatus>().notNull().default("open"),
    minVerificationLevel: text("min_verification_level").$type<VerificationLevel>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    check("conversations_status", inList("status", CONVERSATION_STATUSES)),
    check("conversations_min_level", inList("min_verification_level", VERIFICATION_LEVELS)),
    index("conversations_region").on(t.regionId),
    index("conversations_status_idx").on(t.status),
  ],
);

export const STATEMENT_MAX_LENGTH = 500;

/** A Statement's text is nullable because Redaction clears it while leaving the
 *  Statement and every Vote cast on it intact (ADR-0006). Authorship is nullable
 *  because it is stripped when the author deletes their account — which is a different
 *  answer from Votes, and deliberately so. */
export const statements = pgTable(
  "statements",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => participants.id, { onDelete: "set null", onUpdate: "cascade" }),
    text: text("text"),
    moderationStatus: text("moderation_status").$type<ModerationStatus>().notNull().default("approved"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("statements_moderation_status", inList("moderation_status", MODERATION_STATUSES)),
    check("statements_length", sql`${t.text} is null or char_length(${t.text}) <= ${sql.raw(String(STATEMENT_MAX_LENGTH))}`),
    check("statements_redacted_has_no_text", sql`${t.redactedAt} is null or ${t.text} is null`),
    index("statements_conversation").on(t.conversationId),
  ],
);

/** One Vote per (Participant, Statement), enforced by the composite primary key rather
 *  than by application care: changing your mind is an upsert, not a second row.
 *
 *  This is the one table that does not take a UUID key. ADR-0002 asks for UUIDv7
 *  primary keys everywhere; the M0 specification overrides it here because the
 *  uniqueness rule *is* the key. */
export const votes = pgTable(
  "votes",
  {
    originInstance: originInstance(),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade", onUpdate: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => statements.id, { onDelete: "cascade" }),
    /** -1 disagree, 0 pass, 1 agree. Pass is counted distinctly from an unseen
     *  Statement: "saw it and abstained" and "never saw it" are different facts. */
    value: smallint("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.participantId, t.statementId] }),
    check("votes_value", sql`${t.value} in (-1, 0, 1)`),
    index("votes_statement").on(t.statementId),
  ],
);

/** Recorded per (Participant, Statement, level). Only the strongest level per
 *  Participant contributes when the engine reads it, so pledging twice cannot inflate
 *  the signal. A Commitment confers membership of nothing (ADR-0005). */
export const commitments = pgTable(
  "commitments",
  {
    originInstance: originInstance(),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade", onUpdate: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => statements.id, { onDelete: "cascade" }),
    level: text("level").$type<CommitmentLevel>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.participantId, t.statementId, t.level] }),
    check("commitments_level", inList("level", COMMITMENT_LEVELS)),
    index("commitments_statement").on(t.statementId),
  ],
);

// ---------------------------------------------------------------------------
// Trust and safety
// ---------------------------------------------------------------------------

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => statements.id, { onDelete: "cascade" }),
    /** Nulled when the reporter deletes their account. A Report is not a shared
     *  artefact anyone's results depend on, so there is nothing to preserve by
     *  keeping it attached to the tombstone. */
    reporterId: uuid("reporter_id").references(() => participants.id, { onDelete: "set null", onUpdate: "cascade" }),
    reason: text("reason").notNull(),
    status: text("status").$type<ReportStatus>().notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => participants.id, { onDelete: "set null", onUpdate: "cascade" }),
  },
  (t) => [
    check("reports_status", inList("status", REPORT_STATUSES)),
    index("reports_status_idx").on(t.status),
    index("reports_statement").on(t.statementId),
  ],
);

/**
 * The public, append-only record of every moderation action taken on an Instance.
 *
 * Append-only is structural rather than promised: the migration installs a trigger that
 * raises on UPDATE and DELETE, and the service layer exposes no path to either. A
 * moderation log that a moderator can edit is not a moderation log.
 *
 * `actorId` keeps pointing at the tombstone when a moderator deletes their account,
 * because nulling it would destroy the auditability the log exists for.
 */
export const moderationLog = pgTable(
  "moderation_log",
  {
    id: uuid("id").primaryKey(),
    originInstance: originInstance(),
    /** `restrict` rather than `set null`: a Participant is tombstoned, never row-deleted,
     *  so this never fires in normal operation — and if something ever tries to
     *  row-delete a moderator it should fail loudly rather than quietly erase who
     *  acted. */
    actorId: uuid("actor_id").references(() => participants.id, { onDelete: "restrict", onUpdate: "cascade" }),
    action: text("action").$type<ModerationAction>().notNull(),
    /** Deliberately not called a Target. CONTEXT.md reserves that word for the
     *  decision-maker who could grant a Campaign's ask, and reusing it for "the thing
     *  that was moderated" is exactly the drift the glossary exists to stop. */
    subjectType: text("subject_type").$type<ModerationSubjectType>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("moderation_log_action", inList("action", MODERATION_ACTIONS)),
    check("moderation_log_subject_type", inList("subject_type", MODERATION_SUBJECT_TYPES)),
    index("moderation_log_subject").on(t.subjectType, t.subjectId),
    index("moderation_log_created").on(t.createdAt),
  ],
);

export const schema = {
  instanceSettings,
  regions,
  participants,
  magicLinkTokens,
  sessions,
  vouches,
  conversations,
  statements,
  votes,
  commitments,
  reports,
  moderationLog,
};
