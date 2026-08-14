ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS first_screen_sample_rate Nullable(Float64) AFTER collector_sample_rate,
  ADD COLUMN IF NOT EXISTS blank_detection_sample_rate Nullable(Float64) AFTER first_screen_sample_rate;
