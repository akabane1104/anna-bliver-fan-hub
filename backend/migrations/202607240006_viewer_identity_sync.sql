CREATE TABLE IF NOT EXISTS viewer_identity_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  binding_id INT DEFAULT NULL,
  target_user_id INT NOT NULL,
  bilibili_uid BIGINT DEFAULT NULL,
  action ENUM(
    'sync_confirmed',
    'sync_failed',
    'listener_confirmed',
    'manual_created',
    'manual_updated',
    'manual_revoked',
    'manual_expired',
    'manual_overridden',
    'role_recomputed'
  ) NOT NULL,
  actor_user_id INT DEFAULT NULL,
  actor_role ENUM('fan_club','captain','admiral','governor','streamer','admin') DEFAULT NULL,
  old_role ENUM('fan_club','captain','admiral','governor','streamer','admin') DEFAULT NULL,
  new_role ENUM('fan_club','captain','admiral','governor','streamer','admin') DEFAULT NULL,
  source ENUM('automatic','transient_qr','server_provider','official_listener','manual_fallback') NOT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  valid_until DATETIME(3) DEFAULT NULL,
  event_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY unique_viewer_identity_event (event_key),
  INDEX idx_viewer_identity_target (target_user_id, created_at),
  INDEX idx_viewer_identity_binding (binding_id, created_at),
  INDEX idx_viewer_identity_actor (actor_user_id, created_at),
  CONSTRAINT fk_viewer_identity_binding
    FOREIGN KEY (binding_id) REFERENCES user_bilibili_bindings(id) ON DELETE SET NULL,
  CONSTRAINT fk_viewer_identity_target
    FOREIGN KEY (target_user_id) REFERENCES users(id),
  CONSTRAINT fk_viewer_identity_actor
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'target_anchor_uid'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN target_anchor_uid BIGINT UNSIGNED DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'target_room_id'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN target_room_id BIGINT UNSIGNED DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'fans_medal_level'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN fans_medal_level INT UNSIGNED DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'fans_medal_name'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN fans_medal_name VARCHAR(100) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'fans_medal_status'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN fans_medal_status ENUM(''unknown'',''active'',''inactive'') NOT NULL DEFAULT ''unknown''',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'guard_level'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN guard_level TINYINT UNSIGNED DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'guard_started_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN guard_started_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'guard_expires_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN guard_expires_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'identity_sync_status'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN identity_sync_status ENUM(''never'',''pending'',''success'',''failed'',''unavailable'') NOT NULL DEFAULT ''never''',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'identity_source'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN identity_source ENUM(''transient_qr'',''server_provider'',''official_listener'',''manual_fallback'') DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'last_sync_attempt_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN last_sync_attempt_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'last_sync_success_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN last_sync_success_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'last_sync_error_code'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN last_sync_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'identity_observed_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN identity_observed_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'identity_version'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN identity_version BIGINT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'sync_failure_count'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN sync_failure_count INT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'next_sync_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN next_sync_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'manual_role'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN manual_role ENUM(''fan_club'',''captain'',''admiral'',''governor'') DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'manual_expires_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN manual_expires_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'manual_actor_user_id'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN manual_actor_user_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'manual_reason'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN manual_reason VARCHAR(500) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'manual_created_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN manual_created_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND COLUMN_NAME = 'manual_overridden_at'
);
SET @ddl := IF(@column_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD COLUMN manual_overridden_at DATETIME(3) DEFAULT NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND INDEX_NAME = 'idx_binding_identity_due'
);
SET @ddl := IF(@index_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD INDEX idx_binding_identity_due (identity_sync_status, next_sync_at)',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND INDEX_NAME = 'idx_binding_guard_expiry'
);
SET @ddl := IF(@index_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD INDEX idx_binding_guard_expiry (guard_expires_at)',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bilibili_bindings'
    AND INDEX_NAME = 'idx_binding_manual_expiry'
);
SET @ddl := IF(@index_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD INDEX idx_binding_manual_expiry (manual_expires_at)',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_bilibili_bindings'
    AND CONSTRAINT_NAME = 'fk_binding_manual_actor'
);
SET @ddl := IF(@fk_exists = 0,
  'ALTER TABLE user_bilibili_bindings ADD CONSTRAINT fk_binding_manual_actor FOREIGN KEY (manual_actor_user_id) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE statement FROM @ddl; EXECUTE statement; DEALLOCATE PREPARE statement;
