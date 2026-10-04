CREATE TABLE IF NOT EXISTS object_operation_refs (
 project UUID, env LowCardinality(String), user String, session String, instance String,
 operation LowCardinality(String), objectType LowCardinality(String), at Int64, received Int64, aliases String,
 expires DateTime MATERIALIZED toDateTime(intDiv(received,1000)) + INTERVAL 48 HOUR
) ENGINE=ReplacingMergeTree ORDER BY (project,env,instance,received)
TTL expires DELETE SETTINGS merge_with_ttl_timeout=60;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS repeated_operation_proofs (
 project UUID, env LowCardinality(String), user String, session String, instance String,
 operation LowCardinality(String), at Int64, received Int64,
 proof_from Int64, proof_to Int64, proof_received Int64, hit UInt8, processed Int64,
 expires DateTime MATERIALIZED toDateTime(intDiv(received,1000)) + INTERVAL 90 DAY
) ENGINE=MergeTree ORDER BY (project,env,instance,hit,proof_from,proof_to,proof_received)
TTL expires DELETE;

-- statement-breakpoint
ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS sdk_collectors Nullable(String);
