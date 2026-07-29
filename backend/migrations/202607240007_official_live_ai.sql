CREATE TABLE IF NOT EXISTS official_live_event_dedup (
  event_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_official_event_dedup_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_ai_memory (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  viewer_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_role ENUM('user','assistant') NOT NULL,
  content VARCHAR(800) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_official_ai_memory_viewer (viewer_key, created_at, id),
  INDEX idx_official_ai_memory_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
