-- Additive follow-up: preserve capture/suppression metadata without raw content.
ALTER TABLE diagnostic_receipts ADD COLUMN capture_metadata JSON NULL;
