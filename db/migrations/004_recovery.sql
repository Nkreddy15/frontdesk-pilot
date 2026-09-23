-- Additive hardening; keep previously applied migration hashes unchanged.
ALTER TABLE outbox_jobs ADD COLUMN lease_owner uuid;
ALTER TABLE sync_exceptions ADD COLUMN resolved_at timestamptz;
CREATE INDEX outbox_running_entity ON outbox_jobs(tenant_id,entity_id) WHERE status='RUNNING';
REVOKE ALL ON schema_migrations FROM receptionist_app;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I',role_name);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_appointment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE svc services; staff resources; bay resources;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.location_id<>OLD.location_id THEN RAISE EXCEPTION 'IMMUTABLE_SCOPE'; END IF;
  -- Privacy redaction may clear terminal notes only; no other booking field can change.
  IF OLD.state IN ('CANCELLED','EXPIRED','COMPLETED','NO_SHOW') AND OLD.notes<>'' AND NEW.notes=''
     AND (to_jsonb(NEW)-'notes')=(to_jsonb(OLD)-'notes') THEN
   NEW.version:=OLD.version+1; NEW.reason:='privacy_redaction'; NEW.updated_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF OLD.state IN ('CANCELLED','EXPIRED','COMPLETED','NO_SHOW') THEN RAISE EXCEPTION 'TERMINAL_STATE'; END IF;
  IF OLD.state='CONFIRMED' AND NEW.state NOT IN ('CONFIRMED','CANCELLED','COMPLETED','NO_SHOW') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
  IF OLD.state='HELD' AND NEW.state NOT IN ('HELD','CONFIRMED','CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
  IF OLD.state='HELD' AND NEW.state='CONFIRMED' AND OLD.hold_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'HOLD_EXPIRED'; END IF;
  IF NEW.state='COMPLETED' AND clock_timestamp()<OLD.ends_at THEN RAISE EXCEPTION 'TOO_EARLY'; END IF;
  IF NEW.state='NO_SHOW' AND clock_timestamp()<OLD.starts_at + interval '15 minutes' THEN RAISE EXCEPTION 'TOO_EARLY'; END IF;
  NEW.version:=OLD.version+1;
 END IF;
 IF TG_OP='INSERT' OR NEW.service_id<>OLD.service_id THEN
  SELECT * INTO STRICT svc FROM services WHERE tenant_id=NEW.tenant_id AND id=NEW.service_id AND active;
  NEW.duration_minutes:=svc.duration_minutes; NEW.buffer_before:=svc.buffer_before;
  NEW.buffer_after:=svc.buffer_after; NEW.price_cents:=svc.price_cents; NEW.service_name:=svc.name;
 END IF;
 NEW.ends_at:=NEW.starts_at + make_interval(mins=>NEW.duration_minutes);
 NEW.updated_at:=clock_timestamp();
 SELECT * INTO STRICT staff FROM resources WHERE tenant_id=NEW.tenant_id AND id=NEW.staff_id AND kind='STAFF' AND location_id=NEW.location_id;
 SELECT * INTO STRICT bay FROM resources WHERE tenant_id=NEW.tenant_id AND id=NEW.bay_id AND kind='BAY' AND location_id=NEW.location_id;
 RETURN NEW;
END $$;
