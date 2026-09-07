-- The five-Vouch cap, enforced by the database (ADR-0008, #5).
--
-- The service layer checks it too, because a service can say something useful about
-- why. But a check that is only a SELECT followed by an INSERT is not a cap: two
-- concurrent requests both read four outstanding Vouches and both insert, and the
-- account holds six. The cap exists to bound how much a single compromised account can
-- manufacture, so an attacker racing it is precisely the case it has to survive.
--
-- The lock on the voucher's Participant row is what makes it real: concurrent inserts
-- for the same voucher serialise on it, and inserts for different vouchers do not
-- contend at all.
--
-- Keep MAX_OUTSTANDING_VOUCHES in `src/lib/services/vouches.ts` in step with the 5
-- below; `tests/service/vouches.test.ts` reads the constant and drives the trigger, so
-- a divergence fails there.

CREATE OR REPLACE FUNCTION vouches_enforce_outstanding_cap() RETURNS trigger AS $$
DECLARE
  outstanding integer;
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM participants WHERE id = NEW.voucher_id FOR UPDATE;

  SELECT count(*) INTO outstanding
    FROM vouches
   WHERE voucher_id = NEW.voucher_id
     AND revoked_at IS NULL
     AND id <> NEW.id;

  IF outstanding >= 5 THEN
    RAISE EXCEPTION 'a Participant may hold at most 5 outstanding Vouches'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER vouches_outstanding_cap
  BEFORE INSERT OR UPDATE ON vouches
  FOR EACH ROW EXECUTE FUNCTION vouches_enforce_outstanding_cap();
