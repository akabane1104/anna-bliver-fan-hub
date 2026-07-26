CREATE TABLE IF NOT EXISTS song_request_policies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  song_id INT NOT NULL,
  temporarily_blocked TINYINT(1) NOT NULL DEFAULT 0,
  public_reason VARCHAR(200) DEFAULT NULL,
  internal_note VARCHAR(500) DEFAULT NULL,
  blocked_until DATETIME(3) DEFAULT NULL,
  released_at DATETIME(3) DEFAULT NULL,
  special_event_tag_id INT DEFAULT NULL,
  duration_override_seconds INT UNSIGNED DEFAULT NULL,
  created_by_user_id INT DEFAULT NULL,
  updated_by_user_id INT DEFAULT NULL,
  released_by_user_id INT DEFAULT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY unique_song_request_policy_song (song_id),
  INDEX idx_song_request_policy_block (temporarily_blocked, blocked_until),
  INDEX idx_song_request_policy_event_tag (special_event_tag_id),
  INDEX idx_song_request_policy_creator (created_by_user_id),
  INDEX idx_song_request_policy_updater (updated_by_user_id),
  INDEX idx_song_request_policy_releaser (released_by_user_id),
  CONSTRAINT fk_song_request_policy_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  CONSTRAINT fk_song_request_policy_event_tag FOREIGN KEY (special_event_tag_id) REFERENCES tags(id) ON DELETE SET NULL,
  CONSTRAINT fk_song_request_policy_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_song_request_policy_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_song_request_policy_releaser FOREIGN KEY (released_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS song_request_details (
  request_id BIGINT UNSIGNED PRIMARY KEY,
  canonical_match_method VARCHAR(32) NOT NULL,
  reason_code VARCHAR(50) DEFAULT NULL,
  public_reason VARCHAR(200) DEFAULT NULL,
  internal_note VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_song_request_detail_reason (reason_code, updated_at),
  CONSTRAINT fk_song_request_detail_request FOREIGN KEY (request_id) REFERENCES song_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @phase4i_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE user_bilibili_bindings ADD COLUMN bilibili_open_id VARCHAR(128) COLLATE utf8mb4_bin DEFAULT NULL AFTER bilibili_uid',
    'DO 0'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'bilibili_open_id'
);
PREPARE phase4i_statement FROM @phase4i_sql;
EXECUTE phase4i_statement;
DEALLOCATE PREPARE phase4i_statement;

SET @phase4i_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE user_bilibili_bindings ADD UNIQUE KEY unique_bound_open_id (bilibili_open_id)',
    'DO 0'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_bilibili_bindings'
    AND INDEX_NAME = 'unique_bound_open_id'
);
PREPARE phase4i_statement FROM @phase4i_sql;
EXECUTE phase4i_statement;
DEALLOCATE PREPARE phase4i_statement;

SET @phase4i_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE song_aliases ADD UNIQUE KEY unique_song_alias_normalized (normalized_alias)',
    'DO 0'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'song_aliases'
    AND INDEX_NAME = 'unique_song_alias_normalized'
);
PREPARE phase4i_statement FROM @phase4i_sql;
EXECUTE phase4i_statement;
DEALLOCATE PREPARE phase4i_statement;

SET @phase4i_sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE song_aliases ADD UNIQUE KEY unique_song_alias_script (script_key)',
    'DO 0'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'song_aliases'
    AND INDEX_NAME = 'unique_song_alias_script'
);
PREPARE phase4i_statement FROM @phase4i_sql;
EXECUTE phase4i_statement;
DEALLOCATE PREPARE phase4i_statement;

INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('live_home_song_requests_open', 'true'),
  ('song_request_auto_capacity_blocked', 'false'),
  ('song_request_cooldown_minutes', '60'),
  ('song_request_block_repeat_today', 'false'),
  ('song_request_queue_limit', '12'),
  ('song_request_reopen_threshold', '8'),
  ('song_request_eta_close_minutes', '60'),
  ('song_request_eta_reopen_minutes', '40'),
  ('song_request_default_duration_seconds', '240'),
  ('song_request_buffer_seconds', '60'),
  ('song_request_eta_paused', 'false'),
  ('song_request_active_event_tag_id', ''),
  ('song_request_settings_revision', '0');
