CREATE TABLE "commitments" (
	"origin_instance" uuid,
	"participant_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitments_participant_id_statement_id_level_pk" PRIMARY KEY("participant_id","statement_id","level"),
	CONSTRAINT "commitments_level" CHECK (level in ('support', 'fund', 'show_up', 'skill', 'organize'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"region_id" integer NOT NULL,
	"seed_topic" text NOT NULL,
	"created_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"min_verification_level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "conversations_status" CHECK (status in ('open', 'closed', 'archived')),
	CONSTRAINT "conversations_min_level" CHECK (min_verification_level in ('anonymous', 'email', 'vouched', 'verified'))
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"default_min_verification_level" text DEFAULT 'vouched' NOT NULL,
	"archive_silent_conversations_after_days" integer DEFAULT 14 NOT NULL,
	"conversation_rate_limit" integer DEFAULT 3 NOT NULL,
	"conversation_rate_limit_window_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_singleton_true" CHECK ("instance_settings"."singleton" is true),
	CONSTRAINT "instance_settings_default_level" CHECK (default_min_verification_level in ('anonymous', 'email', 'vouched', 'verified'))
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"email" text NOT NULL,
	"display_name" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moderation_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"email" text,
	"display_name" text,
	"geohash5" char(5),
	"region_id" integer,
	"verification_level" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"tombstoned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "participants_level" CHECK ("participants"."verification_level" is null or verification_level in ('anonymous', 'email', 'vouched', 'verified')),
	CONSTRAINT "participants_geohash5_precision" CHECK ("participants"."geohash5" is null or length("participants"."geohash5") = 5),
	CONSTRAINT "participants_tombstone_is_empty" CHECK ((
        "participants"."tombstoned" = false
        and "participants"."email" is not null
        and "participants"."display_name" is not null
        and "participants"."verification_level" is not null
        and "participants"."created_at" is not null
      ) or (
        "participants"."tombstoned" = true
        and "participants"."origin_instance" is null
        and "participants"."email" is null
        and "participants"."display_name" is null
        and "participants"."geohash5" is null
        and "participants"."region_id" is null
        and "participants"."verification_level" is null
        and "participants"."created_at" is null
        and "participants"."updated_at" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"geoname_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ascii_name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"level" text NOT NULL,
	"parent_id" integer,
	"admin1_code" text,
	"admin2_code" text,
	"dataset_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"statement_id" uuid NOT NULL,
	"reporter_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "reports_status" CHECK (status in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"participant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid,
	"text" text,
	"moderation_status" text DEFAULT 'approved' NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statements_moderation_status" CHECK (moderation_status in ('approved', 'pending', 'removed')),
	CONSTRAINT "statements_length" CHECK ("statements"."text" is null or char_length("statements"."text") <= 500),
	CONSTRAINT "statements_redacted_has_no_text" CHECK ("statements"."redacted_at" is null or "statements"."text" is null)
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"origin_instance" uuid,
	"participant_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_participant_id_statement_id_pk" PRIMARY KEY("participant_id","statement_id"),
	CONSTRAINT "votes_value" CHECK ("votes"."value" in (-1, 0, 1))
);
--> statement-breakpoint
CREATE TABLE "vouches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_instance" uuid,
	"voucher_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "vouches_not_self" CHECK ("vouches"."voucher_id" <> "vouches"."subject_id")
);
--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_region_id_regions_geoname_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("geoname_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_participants_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_log" ADD CONSTRAINT "moderation_log_actor_id_participants_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_region_id_regions_geoname_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("geoname_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_parent_id_regions_geoname_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."regions"("geoname_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_participants_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_participants_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_author_id_participants_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouches" ADD CONSTRAINT "vouches_voucher_id_participants_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouches" ADD CONSTRAINT "vouches_subject_id_participants_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitments_statement" ON "commitments" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "conversations_region" ON "conversations" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_settings_singleton" ON "instance_settings" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_tokens_hash" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_link_tokens_email" ON "magic_link_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "moderation_log_target" ON "moderation_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "moderation_log_created" ON "moderation_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_email" ON "participants" USING btree ("email");--> statement-breakpoint
CREATE INDEX "regions_ascii_name" ON "regions" USING btree ("ascii_name");--> statement-breakpoint
CREATE INDEX "regions_parent" ON "regions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reports_statement" ON "reports" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_hash" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_participant" ON "sessions" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "statements_conversation" ON "statements" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "votes_statement" ON "votes" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vouches_live_pair" ON "vouches" USING btree ("voucher_id","subject_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "vouches_subject" ON "vouches" USING btree ("subject_id");