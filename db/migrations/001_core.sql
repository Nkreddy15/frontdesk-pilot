CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL, timezone text NOT NULL DEFAULT 'America/New_York', address text NOT NULL DEFAULT '',
 phone text NOT NULL DEFAULT '', booking_enabled boolean NOT NULL DEFAULT true,
 hours jsonb NOT NULL DEFAULT '{"1":["09:00","18:00"],"2":["09:00","18:00"],"3":["09:00","18:00"],"4":["09:00","18:00"],"5":["09:00","18:00"],"6":["09:00","16:00"]}',
 horizon_days integer NOT NULL DEFAULT 60 CHECK(horizon_days BETWEEN 1 AND 365),
 min_notice_minutes integer NOT NULL DEFAULT 30 CHECK(min_notice_minutes >= 0),
 UNIQUE(tenant_id,id)
);
CREATE TABLE memberships (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('OWNER','STAFF','VIEWER')), resource_id uuid,
 PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE resources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 location_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('STAFF','BAY')),
 active boolean NOT NULL DEFAULT true, hours jsonb, color text NOT NULL DEFAULT '#2463eb',
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id)
);
CREATE TABLE services (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 location_id uuid NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
 duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480),
 buffer_before integer NOT NULL DEFAULT 0 CHECK(buffer_before BETWEEN 0 AND 120),
 buffer_after integer NOT NULL DEFAULT 0 CHECK(buffer_after BETWEEN 0 AND 120),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 0 AND 10000000), currency text NOT NULL DEFAULT 'USD',
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id)
);
CREATE TABLE service_staff (
 tenant_id uuid NOT NULL, service_id uuid NOT NULL, resource_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,service_id,resource_id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id)
);
CREATE TABLE customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), phone text NOT NULL CHECK(phone ~ '^\+[1-9][0-9]{7,14}$'),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000), created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz, UNIQUE(tenant_id,id)
);
CREATE INDEX customers_phone ON customers(tenant_id,phone);
CREATE TABLE consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, customer_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('SMS_APPOINTMENT','TRANSCRIPTION')),
 granted boolean NOT NULL, method text NOT NULL CHECK(method IN ('WEB_FORM','WRITTEN_IMPORT','KEYPAD','REVOKED')),
 notice_version text NOT NULL, evidence text NOT NULL CHECK(length(evidence) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE TABLE sms_suppressions (
 tenant_id uuid NOT NULL REFERENCES tenants(id), phone text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,phone)
);
CREATE TABLE appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, location_id uuid NOT NULL,
 customer_id uuid NOT NULL, service_id uuid NOT NULL, staff_id uuid NOT NULL, bay_id uuid NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 duration_minutes integer NOT NULL, buffer_before integer NOT NULL, buffer_after integer NOT NULL,
 price_cents integer NOT NULL, service_name text NOT NULL,
 state text NOT NULL CHECK(state IN ('HELD','CONFIRMED','CANCELLED','EXPIRED','COMPLETED','NO_SHOW')),
 source text NOT NULL CHECK(source IN ('OWNER','VOICE','WEBSITE','INTEGRATION','DEMO')),
 hold_expires_at timestamptz, hold_token_hash text,
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
 version integer NOT NULL DEFAULT 1, reason text NOT NULL DEFAULT 'created',
 manage_code_hash text, call_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 CHECK(ends_at>starts_at), CHECK(staff_id<>bay_id),
 CHECK(state<>'HELD' OR (hold_expires_at IS NOT NULL AND hold_token_hash IS NOT NULL)),
 FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES resources(tenant_id,id),
 FOREIGN KEY(tenant_id,bay_id) REFERENCES resources(tenant_id,id)
);
CREATE INDEX appointments_schedule ON appointments(tenant_id,starts_at);
CREATE INDEX appointments_holds ON appointments(tenant_id,hold_expires_at) WHERE state='HELD';
CREATE TABLE resource_blocks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, location_id uuid NOT NULL,
 resource_id uuid NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 200), source text NOT NULL DEFAULT 'OWNER',
 active boolean NOT NULL DEFAULT true, external_key text,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,external_key), CHECK(ends_at>starts_at),
 FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id),
 FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id)
);
CREATE TABLE resource_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 resource_id uuid NOT NULL, appointment_id uuid, block_id uuid, occupied_range tstzrange NOT NULL,
 active boolean NOT NULL DEFAULT true,
 CHECK(num_nonnulls(appointment_id,block_id)=1),
 CHECK(NOT isempty(occupied_range) AND NOT lower_inf(occupied_range) AND NOT upper_inf(occupied_range)
       AND lower_inc(occupied_range) AND NOT upper_inc(occupied_range)),
 UNIQUE(tenant_id,appointment_id,resource_id), UNIQUE(tenant_id,block_id),
 FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id),
 FOREIGN KEY(tenant_id,block_id) REFERENCES resource_blocks(tenant_id,id),
 CONSTRAINT no_resource_overlap EXCLUDE USING gist
 (tenant_id WITH =, resource_id WITH =, occupied_range WITH &&) WHERE(active)
);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL,
 entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
 actor text NOT NULL, trace_id text, before_data jsonb, after_data jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE idempotency_requests (
 tenant_id uuid NOT NULL, operation text NOT NULL, key text NOT NULL,
 request_hash text NOT NULL, http_status integer, result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,operation,key)
);
CREATE TABLE outbox_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 kind text NOT NULL, entity_id uuid NOT NULL, version integer NOT NULL,
 dedup_key text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','BLOCKED','UNKNOWN','SUPERSEDED')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_until timestamptz, last_error text, provider_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,dedup_key)
);
CREATE INDEX outbox_ready ON outbox_jobs(tenant_id,available_at) WHERE status='PENDING';
CREATE TABLE webhook_inbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, provider text NOT NULL,
 dedup_key text NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 UNIQUE(tenant_id,provider,dedup_key)
);
CREATE TABLE calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, location_id uuid NOT NULL,
 provider_sid text, caller_phone text, mode text NOT NULL CHECK(mode IN ('SIMULATOR','TELEPHONE')),
 state text NOT NULL DEFAULT 'ACTIVE', outcome text NOT NULL DEFAULT 'IN_PROGRESS',
 workflow jsonb NOT NULL DEFAULT '{}', summary text NOT NULL DEFAULT '', follow_up text NOT NULL DEFAULT 'NONE',
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
 duration_seconds integer NOT NULL DEFAULT 0, estimated_cost_cents numeric(12,4) NOT NULL DEFAULT 0,
 transcription_consented boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id), UNIQUE(provider_sid), FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id)
);
CREATE TABLE call_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, call_id uuid NOT NULL,
 kind text NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,call_id) REFERENCES calls(tenant_id,id)
);
CREATE TABLE tool_executions (
 tenant_id uuid NOT NULL, call_id uuid NOT NULL, action_id text NOT NULL,
 tool text NOT NULL, arguments jsonb NOT NULL, result jsonb, duration_ms integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,call_id,action_id),
 FOREIGN KEY(tenant_id,call_id) REFERENCES calls(tenant_id,id)
);
CREATE TABLE leads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, call_id uuid,
 name text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', requested_service text NOT NULL DEFAULT '',
 preferred_time text NOT NULL DEFAULT '', reason text NOT NULL, notes text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CONTACTED','CONVERTED','CLOSED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,call_id) REFERENCES calls(tenant_id,id)
);
CREATE TABLE knowledge (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, topic text NOT NULL,
 question text NOT NULL, answer text NOT NULL, published boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,topic)
);
CREATE TABLE business_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 greeting text NOT NULL DEFAULT 'Thanks for calling. I am the AI receptionist. I can help with appointments or connect you to the team.',
 transfer_enabled boolean NOT NULL DEFAULT false, transfer_number text NOT NULL DEFAULT '',
 transfer_rules jsonb NOT NULL DEFAULT '{"on_request":true,"angry_caller":true,"after_failures":2}',
 recording_enabled boolean NOT NULL DEFAULT false CHECK(recording_enabled=false),
 transcript_retention_days integer NOT NULL DEFAULT 30 CHECK(transcript_retention_days BETWEEN 1 AND 90),
 lead_retention_days integer NOT NULL DEFAULT 90 CHECK(lead_retention_days BETWEEN 1 AND 365),
 booking_paused boolean NOT NULL DEFAULT false,
 approved_for_live boolean NOT NULL DEFAULT false, consent_notice text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE calendar_connections (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), location_id uuid NOT NULL,
 calendar_id text, encrypted_tokens text NOT NULL, status text NOT NULL DEFAULT 'CONNECTED',
 channel_id text, channel_token text, resource_id text, channel_expires_at timestamptz,
 sync_token text, last_synced_at timestamptz, last_error text,
 FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id)
);
CREATE TABLE calendar_projections (
 tenant_id uuid NOT NULL, appointment_id uuid NOT NULL, event_id text NOT NULL,
 applied_version integer NOT NULL DEFAULT 0, generation integer NOT NULL DEFAULT 0, etag text,
 PRIMARY KEY(tenant_id,appointment_id), UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
CREATE TABLE external_events (
 tenant_id uuid NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,event_id)
);
CREATE TABLE sync_exceptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 event_id text, reason text NOT NULL, resolved boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE phone_routes (
 phone text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), location_id uuid NOT NULL,
 FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id)
);

CREATE FUNCTION guard_appointment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE svc services; staff resources; bay resources;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.location_id<>OLD.location_id THEN RAISE EXCEPTION 'IMMUTABLE_SCOPE'; END IF;
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
CREATE TRIGGER appointment_guard BEFORE INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION guard_appointment();

CREATE FUNCTION project_appointment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE busy tstzrange; enabled boolean; msg text; previous jsonb;
BEGIN
 busy:=tstzrange(NEW.starts_at-make_interval(mins=>NEW.buffer_before),NEW.ends_at+make_interval(mins=>NEW.buffer_after),'[)');
 enabled:=NEW.state NOT IN ('CANCELLED','EXPIRED');
 -- Updating existing claims never opens a gap outside this transaction.
 DELETE FROM resource_reservations WHERE tenant_id=NEW.tenant_id AND appointment_id=NEW.id AND resource_id NOT IN(NEW.staff_id,NEW.bay_id);
 INSERT INTO resource_reservations(tenant_id,resource_id,appointment_id,occupied_range,active)
 SELECT NEW.tenant_id,r,NEW.id,busy,enabled FROM unnest(ARRAY[NEW.staff_id,NEW.bay_id]) r
 ON CONFLICT(tenant_id,appointment_id,resource_id) DO UPDATE SET occupied_range=EXCLUDED.occupied_range,active=EXCLUDED.active;
 IF TG_OP='UPDATE' THEN previous:=jsonb_build_object('state',OLD.state,'starts_at',OLD.starts_at,'version',OLD.version,'staff_id',OLD.staff_id); END IF;
 INSERT INTO audit_events(tenant_id,entity_type,entity_id,action,actor,trace_id,before_data,after_data)
 VALUES(NEW.tenant_id,'appointment',NEW.id,NEW.reason,COALESCE(NULLIF(current_setting('app.actor',true),''),'system'),current_setting('app.trace',true),previous,
 jsonb_build_object('state',NEW.state,'starts_at',NEW.starts_at,'version',NEW.version,'staff_id',NEW.staff_id));
 IF NEW.state='CONFIRMED' THEN
  IF TG_OP='INSERT' THEN msg:='sms.confirm';
  ELSIF OLD.state='HELD' THEN msg:='sms.confirm'; ELSE msg:='sms.reschedule'; END IF;
 ELSIF NEW.state='CANCELLED' AND TG_OP='UPDATE' THEN
  IF OLD.state='CONFIRMED' THEN msg:='sms.cancel'; END IF;
 END IF;
 IF msg IS NOT NULL THEN
  INSERT INTO outbox_jobs(tenant_id,kind,entity_id,version,dedup_key) VALUES
   (NEW.tenant_id,msg,NEW.id,NEW.version,NEW.id||':'||NEW.version||':'||msg),
   (NEW.tenant_id,'calendar.sync',NEW.id,NEW.version,NEW.id||':'||NEW.version||':calendar.sync') ON CONFLICT DO NOTHING;
  IF NEW.state='CONFIRMED' AND NEW.starts_at-interval '2 hours'>clock_timestamp() THEN
   INSERT INTO outbox_jobs(tenant_id,kind,entity_id,version,dedup_key,available_at)
   VALUES(NEW.tenant_id,'sms.reminder',NEW.id,NEW.version,NEW.id||':'||NEW.version||':sms.reminder',NEW.starts_at-interval '2 hours') ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER appointment_projection AFTER INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION project_appointment();

CREATE FUNCTION project_block() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 INSERT INTO resource_reservations(tenant_id,resource_id,block_id,occupied_range,active)
 VALUES(NEW.tenant_id,NEW.resource_id,NEW.id,tstzrange(NEW.starts_at,NEW.ends_at,'[)'),NEW.active)
 ON CONFLICT(tenant_id,block_id) DO UPDATE SET occupied_range=EXCLUDED.occupied_range,active=EXCLUDED.active,resource_id=EXCLUDED.resource_id;
 INSERT INTO audit_events(tenant_id,entity_type,entity_id,action,actor,trace_id,after_data)
 VALUES(NEW.tenant_id,'block',NEW.id,CASE WHEN NEW.active THEN 'block_changed' ELSE 'block_released' END,
 COALESCE(NULLIF(current_setting('app.actor',true),''),'system'),current_setting('app.trace',true),jsonb_build_object('starts_at',NEW.starts_at,'ends_at',NEW.ends_at,'resource_id',NEW.resource_id));
 RETURN NEW;
END $$;
CREATE TRIGGER block_projection AFTER INSERT OR UPDATE ON resource_blocks FOR EACH ROW EXECUTE FUNCTION project_block();

DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'phone_routes' LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants USING(id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT USAGE ON SCHEMA public TO receptionist_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO receptionist_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO receptionist_app;
REVOKE INSERT,UPDATE,DELETE ON resource_reservations,audit_events,phone_routes FROM receptionist_app;
REVOKE DELETE ON appointments,resource_blocks FROM receptionist_app;
REVOKE ALL ON FUNCTION guard_appointment(),project_appointment(),project_block() FROM PUBLIC;
