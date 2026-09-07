-- A Moderator can put back a Statement they removed (#15).
--
-- The Moderation Log's action vocabulary is a closed set precisely so that whoever
-- audits it years from now reads a fixed vocabulary rather than whatever strings
-- accumulated, which is why adding one costs a migration. That is the intended price.

ALTER TABLE "moderation_log" DROP CONSTRAINT "moderation_log_action";--> statement-breakpoint
ALTER TABLE "moderation_log" ADD CONSTRAINT "moderation_log_action" CHECK (action in ('statement_removed', 'statement_restored', 'statement_redacted', 'report_resolved', 'report_dismissed'));