-- Run with a tenant-scoped runtime transaction; do not expose this endpoint publicly.
-- BEGIN; SELECT set_config('app.tenant_id','<tenant UUID>',true); ... COMMIT;
SELECT status, kind, count(*), min(created_at) AS oldest FROM outbox_jobs
WHERE status IN ('PENDING','FAILED','UNKNOWN','BLOCKED','RUNNING') GROUP BY status,kind;
SELECT count(*) AS unresolved_calendar_exceptions FROM sync_exceptions WHERE NOT resolved;
SELECT last_synced_at,status,last_error FROM calendar_connections;
SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) AS tool_p50_ms,
       percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms) AS tool_p95_ms
FROM tool_executions WHERE created_at>now()-interval '1 hour';
SELECT mode,outcome,count(*) FROM calls WHERE started_at>now()-interval '1 day' GROUP BY mode,outcome;
SELECT count(*) AS overlapping_active_reservations FROM resource_reservations a JOIN resource_reservations b
ON a.tenant_id=b.tenant_id AND a.resource_id=b.resource_id AND a.id<b.id
AND a.active AND b.active AND a.occupied_range && b.occupied_range;
