CREATE TABLE IF NOT EXISTS obs_overlay_events (
  sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type ENUM(
    'gift_thanks',
    'guard_alert',
    'cotton_candy',
    'ai_bubble',
    'notice'
  ) NOT NULL,
  source ENUM('manual','simulator','bilibili','ai') NOT NULL,
  payload_json JSON NOT NULL,
  display_duration_ms INT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_user_id INT DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  replay_until DATETIME(3) NOT NULL,
  dismissed_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY unique_obs_overlay_public_id (public_id),
  UNIQUE KEY unique_obs_overlay_source_idempotency (source, idempotency_key),
  INDEX idx_obs_overlay_created (created_at, sequence),
  INDEX idx_obs_overlay_replay (dismissed_at, replay_until, sequence),
  INDEX idx_obs_overlay_creator (created_by_user_id),
  CONSTRAINT fk_obs_overlay_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
