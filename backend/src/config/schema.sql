SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS anna_bliver_fan_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE anna_bliver_fan_hub;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('user','premium','admin') NOT NULL DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settings (
  setting_key VARCHAR(80) PRIMARY KEY,
  setting_value VARCHAR(500) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  permission_key VARCHAR(80) NOT NULL,
  UNIQUE KEY unique_user_permission (user_id, permission_key),
  CONSTRAINT fk_permission_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE email_verification_codes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(100) NOT NULL,
  code VARCHAR(6) NOT NULL,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_verification_email (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE playlists (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  image_url VARCHAR(500),
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_playlist_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE songs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  playlist_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  artist VARCHAR(255) NOT NULL,
  duration VARCHAR(20),
  note TEXT,
  song_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_song_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  color VARCHAR(20) NOT NULL DEFAULT '#6c5ce7'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE song_tags (
  song_id INT NOT NULL,
  tag_id INT NOT NULL,
  PRIMARY KEY (song_id, tag_id),
  CONSTRAINT fk_song_tag_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  CONSTRAINT fk_song_tag_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE marshmallows (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL UNIQUE,
  title VARCHAR(200),
  sender_alias VARCHAR(100),
  content TEXT NOT NULL,
  user_id INT DEFAULT NULL,
  reply_content TEXT,
  reply_at DATETIME DEFAULT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_marshmallow_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE marshmallow_reads (
  user_id INT NOT NULL,
  marshmallow_id BIGINT NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, marshmallow_id),
  CONSTRAINT fk_marshmallow_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_marshmallow_read_item FOREIGN KEY (marshmallow_id) REFERENCES marshmallows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_bilibili_bindings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  bilibili_uid BIGINT NOT NULL,
  bilibili_open_id VARCHAR(128) COLLATE utf8mb4_bin DEFAULT NULL,
  bilibili_uname VARCHAR(100),
  bilibili_face VARCHAR(500),
  status ENUM('verified') NOT NULL DEFAULT 'verified',
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_bound_uid (bilibili_uid),
  UNIQUE KEY unique_bound_open_id (bilibili_open_id),
  UNIQUE KEY unique_user_uid (user_id, bilibili_uid),
  CONSTRAINT fk_binding_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE point_wallets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL UNIQUE,
  primary_bilibili_uid BIGINT DEFAULT NULL,
  points_balance INT NOT NULL DEFAULT 0,
  remainder_coin BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE point_accounts (
  bilibili_uid BIGINT PRIMARY KEY,
  bilibili_uname VARCHAR(100),
  bilibili_face VARCHAR(500),
  claimed_user_id INT DEFAULT NULL,
  wallet_id INT NOT NULL,
  claimed_at DATETIME DEFAULT NULL,
  last_spent_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_point_account_wallet (wallet_id),
  CONSTRAINT fk_point_account_wallet FOREIGN KEY (wallet_id) REFERENCES point_wallets(id),
  CONSTRAINT fk_point_account_user FOREIGN KEY (claimed_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE point_account_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  wallet_id INT NOT NULL,
  bilibili_uid BIGINT DEFAULT NULL,
  user_id INT DEFAULT NULL,
  source VARCHAR(50) NOT NULL,
  currency_type ENUM('points') NOT NULL DEFAULT 'points',
  points_delta INT NOT NULL,
  balance_before INT NOT NULL,
  balance_after INT NOT NULL,
  battery_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  remainder_battery DECIMAL(18,2) NOT NULL DEFAULT 0,
  room_id BIGINT DEFAULT NULL,
  reference_type VARCHAR(50),
  reference_id VARCHAR(255),
  reason TEXT,
  metadata JSON,
  operated_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_point_tx_wallet (wallet_id, created_at),
  INDEX idx_point_tx_uid (bilibili_uid, created_at),
  UNIQUE KEY unique_source_reference (source, reference_type, reference_id),
  CONSTRAINT fk_point_tx_wallet FOREIGN KEY (wallet_id) REFERENCES point_wallets(id),
  CONSTRAINT fk_point_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_point_tx_operator FOREIGN KEY (operated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE bilibili_point_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type ENUM('gift','super_chat') NOT NULL,
  room_id BIGINT NOT NULL,
  bilibili_uid BIGINT NOT NULL,
  bilibili_uname VARCHAR(100),
  total_coin BIGINT NOT NULL,
  event_at DATETIME NOT NULL,
  payload JSON,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  settled_at DATETIME DEFAULT NULL,
  rejection_reason VARCHAR(255),
  INDEX idx_point_event_pending (settled_at, room_id, event_at),
  INDEX idx_point_event_uid (bilibili_uid, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS live_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  schema_version VARCHAR(16) NOT NULL,
  event_type ENUM(
    'danmaku',
    'gift',
    'super_chat',
    'guard_buy',
    'like',
    'room_enter',
    'live_start',
    'live_end'
  ) NOT NULL,
  site_id VARCHAR(64) NOT NULL,
  room_id VARCHAR(32) NOT NULL,
  mode ENUM('live','simulation','replay') NOT NULL,
  source_cmd VARCHAR(100) NOT NULL,
  source_message_id VARCHAR(255) DEFAULT NULL,
  source_session_id VARCHAR(255) DEFAULT NULL,
  actor_open_id VARCHAR(128) COLLATE utf8mb4_bin DEFAULT NULL,
  actor_union_id VARCHAR(128) COLLATE utf8mb4_bin DEFAULT NULL,
  actor_display_name VARCHAR(100) DEFAULT NULL,
  occurred_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  normalized_payload JSON NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('recorded') NOT NULL DEFAULT 'recorded',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY unique_live_event_id (event_id),
  INDEX idx_live_event_target (site_id, room_id, occurred_at),
  INDEX idx_live_event_type (event_type, occurred_at),
  INDEX idx_live_event_actor (actor_open_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS live_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  site_id VARCHAR(64) NOT NULL,
  room_id VARCHAR(32) NOT NULL,
  playlist_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  status ENUM('draft','open','paused','closed') NOT NULL DEFAULT 'draft',
  active_marker TINYINT GENERATED ALWAYS AS (
    CASE WHEN status IN ('open','paused') THEN 1 ELSE NULL END
  ) STORED,
  created_by_user_id INT DEFAULT NULL,
  started_at DATETIME(3) DEFAULT NULL,
  paused_at DATETIME(3) DEFAULT NULL,
  ended_at DATETIME(3) DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY unique_live_session_public_id (public_id),
  UNIQUE KEY unique_live_session_active (site_id, room_id, active_marker),
  INDEX idx_live_session_target (site_id, room_id, status, created_at),
  INDEX idx_live_session_playlist (playlist_id),
  CONSTRAINT fk_live_session_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id),
  CONSTRAINT fk_live_session_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS song_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id BIGINT UNSIGNED DEFAULT NULL,
  site_id VARCHAR(64) NOT NULL,
  room_id VARCHAR(32) NOT NULL,
  source ENUM('bilibili_danmaku','website','manual','simulation','replay') NOT NULL,
  source_event_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  idempotency_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  requester_user_id INT DEFAULT NULL,
  requester_open_id VARCHAR(128) COLLATE utf8mb4_bin DEFAULT NULL,
  requester_display_name VARCHAR(100) DEFAULT NULL,
  raw_request_text TEXT NOT NULL,
  requested_title VARCHAR(512) NOT NULL,
  normalized_query VARCHAR(512) NOT NULL,
  matched_song_id INT DEFAULT NULL,
  match_method ENUM(
    'exact',
    'normalized_exact',
    'script_exact',
    'alias_exact',
    'alias_script',
    'ambiguous',
    'unmatched',
    'manual'
  ) NOT NULL,
  match_confidence DECIMAL(5,4) DEFAULT NULL,
  status ENUM(
    'observed',
    'needs_match',
    'queued',
    'active',
    'completed',
    'rejected',
    'cancelled',
    'skipped',
    'failed'
  ) NOT NULL,
  fulfillment_type ENUM('undecided','sung','played') NOT NULL DEFAULT 'undecided',
  queue_order BIGINT UNSIGNED DEFAULT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  requested_at DATETIME(3) NOT NULL,
  activated_at DATETIME(3) DEFAULT NULL,
  completed_at DATETIME(3) DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY unique_song_request_public_id (public_id),
  UNIQUE KEY unique_song_request_source_event (source_event_id),
  UNIQUE KEY unique_song_request_idempotency (requester_user_id, idempotency_key),
  UNIQUE KEY unique_song_request_queue_order (session_id, queue_order),
  INDEX idx_song_request_current (session_id, status, queue_order),
  INDEX idx_song_request_observed (site_id, room_id, status, requested_at),
  INDEX idx_song_request_song (matched_song_id),
  CONSTRAINT fk_song_request_session FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_song_request_user FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_song_request_song FOREIGN KEY (matched_song_id) REFERENCES songs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS song_request_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  from_status ENUM(
    'observed',
    'needs_match',
    'queued',
    'active',
    'completed',
    'rejected',
    'cancelled',
    'skipped',
    'failed'
  ) DEFAULT NULL,
  to_status ENUM(
    'observed',
    'needs_match',
    'queued',
    'active',
    'completed',
    'rejected',
    'cancelled',
    'skipped',
    'failed'
  ) DEFAULT NULL,
  action VARCHAR(50) NOT NULL,
  actor_user_id INT DEFAULT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  metadata JSON DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_song_request_history_request (request_id, created_at, id),
  INDEX idx_song_request_history_actor (actor_user_id, created_at),
  CONSTRAINT fk_song_request_history_request FOREIGN KEY (request_id) REFERENCES song_requests(id),
  CONSTRAINT fk_song_request_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS song_aliases (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  song_id INT NOT NULL,
  alias VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  normalized_alias VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  script_key VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  loose_candidate_key VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  created_by_user_id INT DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY unique_song_alias_equivalent (song_id, loose_candidate_key),
  UNIQUE KEY unique_song_alias_normalized (normalized_alias),
  UNIQUE KEY unique_song_alias_script (script_key),
  INDEX idx_song_alias_normalized (normalized_alias, song_id),
  INDEX idx_song_alias_script (script_key, song_id),
  CONSTRAINT fk_song_alias_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  CONSTRAINT fk_song_alias_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE prizes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  cost INT NOT NULL,
  image_url VARCHAR(500),
  stock INT NOT NULL DEFAULT 0,
  delivery_type ENUM('physical','virtual') NOT NULL DEFAULT 'physical',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  auto_carousel TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE prize_images (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prize_id INT NOT NULL,
  image_url TEXT NOT NULL,
  alt_text VARCHAR(255),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prize_image_item FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE prize_options (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prize_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  image_url VARCHAR(500),
  cost INT NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prize_option_item FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE prize_cart_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  prize_id INT NOT NULL,
  prize_option_id INT DEFAULT NULL,
  currency_type ENUM('points') NOT NULL DEFAULT 'points',
  quantity INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_cart_line (user_id, prize_id, prize_option_id),
  CONSTRAINT fk_cart_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_cart_prize FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE CASCADE,
  CONSTRAINT fk_cart_option FOREIGN KEY (prize_option_id) REFERENCES prize_options(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE shipping_addresses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  recipient_name VARCHAR(100) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  province VARCHAR(100) NOT NULL DEFAULT '',
  city VARCHAR(100) NOT NULL DEFAULT '',
  district VARCHAR(100) NOT NULL DEFAULT '',
  address_line VARCHAR(500) NOT NULL,
  postal_code VARCHAR(20) NOT NULL DEFAULT '',
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_address_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE prize_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  status ENUM('pending','processing','shipped','completed','cancelled','rejected') NOT NULL DEFAULT 'pending',
  points_total INT NOT NULL DEFAULT 0,
  recipient_name VARCHAR(100), phone VARCHAR(40), province VARCHAR(100), city VARCHAR(100), district VARCHAR(100),
  address_line VARCHAR(500), postal_code VARCHAR(20), remark TEXT, status_reason TEXT,
  refunded_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_order_user (user_id, created_at),
  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE redemptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  prize_id INT NOT NULL,
  prize_option_id INT DEFAULT NULL,
  quantity INT NOT NULL DEFAULT 1,
  points_cost INT NOT NULL,
  currency_type ENUM('points') NOT NULL DEFAULT 'points',
  unit_cost INT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  address_id INT DEFAULT NULL,
  remark TEXT,
  refunded_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_redemption_order FOREIGN KEY (order_id) REFERENCES prize_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_redemption_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_redemption_prize FOREIGN KEY (prize_id) REFERENCES prizes(id),
  CONSTRAINT fk_redemption_option FOREIGN KEY (prize_option_id) REFERENCES prize_options(id) ON DELETE SET NULL,
  CONSTRAINT fk_redemption_address FOREIGN KEY (address_id) REFERENCES shipping_addresses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO playlists (title, description, created_by)
VALUES ('网站歌单', '网站唯一歌曲列表', NULL);

INSERT INTO settings (setting_key, setting_value) VALUES
  ('registration_open', 'true'),
  ('site_playlist_id', CAST(LAST_INSERT_ID() AS CHAR)),
  ('site_title', '橙吱_sweety的钢板批发小店'),
  ('navbar_brand_mode', 'icon-text'),
  ('navbar_brand_text', '橙吱_sweety'),
  ('navbar_logo_url', '/branding/chengzhi-sweety-logo.png'),
  ('favicon_url', '/favicon.ico'),
  ('creator_display_name', '橙吱_sweety'),
  ('bilibili_uid', '24856973'),
  ('home_title', '欢迎各位霸总来到橙吱钢板批发小店'),
  ('home_subtitle', '养成系全职歌势~'),
  ('playlist_title', '橙吱_sweety的歌单'),
  ('theme_primary_color', '#C04D00'),
  ('theme_light_color', '#FF8A00'),
  ('theme_dark_color', '#803200'),
  ('theme_background_color', '#FFF8EF'),
  ('theme_background_accent_color', '#FFE0B2'),
  ('theme_text_dark_color', '#362217'),
  ('theme_text_light_color', '#6E5747'),
  ('theme_border_soft_color', '#F0BF83'),
  ('theme_surface_subtle_color', '#ffffff'),
  ('theme_surface_muted_color', '#FFF0DA'),
  ('theme_success_color', '#2E7D57'),
  ('theme_warning_color', '#9A5700'),
  ('theme_danger_color', '#C43D4D'),
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
