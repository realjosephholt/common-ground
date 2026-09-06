-- The Moderation Log is append-only, and that has to be structural rather than a
-- promise the service layer makes. A log a moderator can quietly edit is not a log,
-- and the whole point of publishing it is that suppression of a Cause would be
-- visible rather than invisible (ADR-0006, #10).
--
-- The service layer additionally exposes no update or delete path. This trigger is the
-- backstop for everything that reaches the database by another route: a psql session,
-- a future service, an admin tool nobody has written yet.

CREATE OR REPLACE FUNCTION moderation_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'moderation_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER moderation_log_no_update
  BEFORE UPDATE ON moderation_log
  FOR EACH ROW EXECUTE FUNCTION moderation_log_is_append_only();
--> statement-breakpoint
CREATE TRIGGER moderation_log_no_delete
  BEFORE DELETE ON moderation_log
  FOR EACH ROW EXECUTE FUNCTION moderation_log_is_append_only();
