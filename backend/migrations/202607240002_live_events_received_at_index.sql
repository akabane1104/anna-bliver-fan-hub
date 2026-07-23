ALTER TABLE live_events
  ADD INDEX idx_live_event_received (received_at, id);
