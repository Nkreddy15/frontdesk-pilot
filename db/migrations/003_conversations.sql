ALTER TABLE calls ADD COLUMN workflow_lock_until timestamptz;
ALTER TABLE calls ADD COLUMN workflow_lock_owner text;
CREATE UNIQUE INDEX one_open_lead_per_call ON leads(tenant_id,call_id) WHERE call_id IS NOT NULL AND status='OPEN';
