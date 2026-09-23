CREATE FUNCTION record_audit(kind text,entity uuid,event text,data jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 INSERT INTO audit_events(tenant_id,entity_type,entity_id,action,actor,trace_id,after_data)
 VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,kind,entity,event,current_setting('app.actor',true),current_setting('app.trace',true),data)
$$;
REVOKE ALL ON FUNCTION record_audit(text,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_audit(text,uuid,text,jsonb) TO receptionist_app;
ALTER TABLE outbox_jobs ADD COLUMN delivery_status text;
ALTER TABLE outbox_jobs ADD COLUMN sent_at timestamptz;
ALTER TABLE calls ADD COLUMN transcript_purged_at timestamptz;
ALTER TABLE business_settings ADD COLUMN onboarding_checklist jsonb NOT NULL DEFAULT '{}';
CREATE TABLE oauth_states (
 tenant_id uuid NOT NULL, token_hash text PRIMARY KEY, user_id uuid NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz
);
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON oauth_states USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON oauth_states TO receptionist_app;
CREATE INDEX calls_started ON calls(tenant_id,started_at DESC);
CREATE INDEX audit_created ON audit_events(tenant_id,created_at DESC);
CREATE INDEX call_events_call ON call_events(tenant_id,call_id,id);
CREATE INDEX reservations_appointment ON resource_reservations(tenant_id,appointment_id);
