const TABLE_CHARSET = 'utf8mb4';
const TABLE_COLLATION = 'utf8mb4_unicode_ci';

function column(name, type, options = {}) {
  return {
    name,
    type: type.toLowerCase(),
    nullable: options.nullable === true,
    default: options.default === undefined ? null : String(options.default),
    charset: options.charset || null,
    collation: options.collation || null,
    auto_increment: options.auto_increment === true,
    generated: options.generated || null,
    generation_expression: options.generation_expression || null,
    on_update: options.on_update || null
  };
}

function textColumn(name, type, options = {}) {
  return column(name, type, {
    ...options,
    charset: options.charset || TABLE_CHARSET,
    collation: options.collation || TABLE_COLLATION
  });
}

function asciiColumn(name, type, options = {}) {
  return column(name, type, {
    ...options,
    charset: 'ascii',
    collation: 'ascii_bin'
  });
}

function binaryTextColumn(name, type, options = {}) {
  return textColumn(name, type, {
    ...options,
    collation: 'utf8mb4_bin'
  });
}

function index(name, unique, columns) {
  return { name, unique, columns };
}

function foreignKey(name, columns, referencedTable, referencedColumns, onDelete = 'NO ACTION') {
  return {
    name,
    columns,
    referenced_table: referencedTable,
    referenced_columns: referencedColumns,
    on_delete: onDelete,
    on_update: 'NO ACTION'
  };
}

function table(columns, indexes, foreignKeys = []) {
  return {
    engine: 'INNODB',
    charset: TABLE_CHARSET,
    collation: TABLE_COLLATION,
    columns,
    indexes,
    foreign_keys: foreignKeys
  };
}

const EVENT_TYPES = "enum('danmaku','gift','super_chat','guard_buy','like','room_enter','live_start','live_end')";
const REQUEST_STATUSES = "enum('observed','needs_match','queued','active','completed','rejected','cancelled','skipped','failed')";

const targetContracts = Object.freeze({
  official_live_event_dedup: table([
    asciiColumn('event_digest', 'char(64)'),
    asciiColumn('event_type', 'varchar(64)'),
    column('first_seen_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('expires_at', 'datetime(3)')
  ], [
    index('PRIMARY', true, ['event_digest']),
    index('idx_official_event_dedup_expiry', false, ['expires_at'])
  ]),

  official_ai_memory: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    asciiColumn('viewer_key', 'char(64)'),
    textColumn('message_role', "enum('user','assistant')"),
    textColumn('content', 'varchar(800)'),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('expires_at', 'datetime(3)')
  ], [
    index('PRIMARY', true, ['id']),
    index('idx_official_ai_memory_viewer', false, ['viewer_key', 'created_at', 'id']),
    index('idx_official_ai_memory_expiry', false, ['expires_at'])
  ]),

  live_events: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    asciiColumn('event_id', 'varchar(255)'),
    textColumn('schema_version', 'varchar(16)'),
    textColumn('event_type', EVENT_TYPES),
    textColumn('site_id', 'varchar(64)'),
    textColumn('room_id', 'varchar(32)'),
    textColumn('mode', "enum('live','simulation','replay')"),
    textColumn('source_cmd', 'varchar(100)'),
    textColumn('source_message_id', 'varchar(255)', { nullable: true }),
    textColumn('source_session_id', 'varchar(255)', { nullable: true }),
    binaryTextColumn('actor_open_id', 'varchar(128)', { nullable: true }),
    binaryTextColumn('actor_union_id', 'varchar(128)', { nullable: true }),
    textColumn('actor_display_name', 'varchar(100)', { nullable: true }),
    column('occurred_at', 'datetime(3)'),
    column('received_at', 'datetime(3)'),
    column('normalized_payload', 'json'),
    asciiColumn('content_hash', 'char(64)'),
    textColumn('status', "enum('recorded')", { default: 'recorded' }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' })
  ], [
    index('PRIMARY', true, ['id']),
    index('idx_live_event_actor', false, ['actor_open_id', 'occurred_at']),
    index('idx_live_event_target', false, ['site_id', 'room_id', 'occurred_at']),
    index('idx_live_event_type', false, ['event_type', 'occurred_at']),
    index('unique_live_event_id', true, ['event_id'])
  ]),

  live_sessions: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    asciiColumn('public_id', 'char(36)'),
    textColumn('site_id', 'varchar(64)'),
    textColumn('room_id', 'varchar(32)'),
    column('playlist_id', 'int'),
    textColumn('title', 'varchar(200)'),
    textColumn('status', "enum('draft','open','paused','closed')", { default: 'draft' }),
    column('active_marker', 'tinyint', {
      nullable: true,
      generated: 'STORED',
      generation_expression: "casewhenstatusin'open','paused'then1elsenullend"
    }),
    column('created_by_user_id', 'int', { nullable: true }),
    column('started_at', 'datetime(3)', { nullable: true }),
    column('paused_at', 'datetime(3)', { nullable: true }),
    column('ended_at', 'datetime(3)', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('updated_at', 'timestamp(3)', {
      default: 'CURRENT_TIMESTAMP(3)',
      on_update: 'CURRENT_TIMESTAMP(3)'
    }),
    column('version', 'int unsigned', { default: 0 })
  ], [
    index('PRIMARY', true, ['id']),
    index('fk_live_session_creator', false, ['created_by_user_id']),
    index('idx_live_session_playlist', false, ['playlist_id']),
    index('idx_live_session_target', false, ['site_id', 'room_id', 'status', 'created_at']),
    index('unique_live_session_active', true, ['site_id', 'room_id', 'active_marker']),
    index('unique_live_session_public_id', true, ['public_id'])
  ], [
    foreignKey('fk_live_session_creator', ['created_by_user_id'], 'users', ['id'], 'SET NULL'),
    foreignKey('fk_live_session_playlist', ['playlist_id'], 'playlists', ['id'])
  ]),

  song_requests: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    asciiColumn('public_id', 'char(36)'),
    column('session_id', 'bigint unsigned', { nullable: true }),
    textColumn('site_id', 'varchar(64)'),
    textColumn('room_id', 'varchar(32)'),
    textColumn('source', "enum('bilibili_danmaku','website','manual','simulation','replay')"),
    asciiColumn('source_event_id', 'varchar(255)', { nullable: true }),
    asciiColumn('idempotency_key', 'varchar(128)', { nullable: true }),
    asciiColumn('idempotency_fingerprint', 'char(64)', { nullable: true }),
    column('requester_user_id', 'int', { nullable: true }),
    binaryTextColumn('requester_open_id', 'varchar(128)', { nullable: true }),
    textColumn('requester_display_name', 'varchar(100)', { nullable: true }),
    textColumn('raw_request_text', 'text'),
    textColumn('requested_title', 'varchar(512)'),
    textColumn('normalized_query', 'varchar(512)'),
    column('matched_song_id', 'int', { nullable: true }),
    textColumn(
      'match_method',
      "enum('exact','normalized_exact','script_exact','alias_exact','alias_script','ambiguous','unmatched','manual')"
    ),
    column('match_confidence', 'decimal(5,4)', { nullable: true }),
    textColumn('status', REQUEST_STATUSES),
    textColumn('fulfillment_type', "enum('undecided','sung','played')", { default: 'undecided' }),
    column('queue_order', 'bigint unsigned', { nullable: true }),
    textColumn('reason', 'varchar(500)', { nullable: true }),
    column('version', 'int unsigned', { default: 0 }),
    column('requested_at', 'datetime(3)'),
    column('activated_at', 'datetime(3)', { nullable: true }),
    column('completed_at', 'datetime(3)', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('updated_at', 'timestamp(3)', {
      default: 'CURRENT_TIMESTAMP(3)',
      on_update: 'CURRENT_TIMESTAMP(3)'
    })
  ], [
    index('PRIMARY', true, ['id']),
    index('idx_song_request_current', false, ['session_id', 'status', 'queue_order']),
    index('idx_song_request_observed', false, ['site_id', 'room_id', 'status', 'requested_at']),
    index('idx_song_request_song', false, ['matched_song_id']),
    index('unique_song_request_idempotency', true, ['requester_user_id', 'idempotency_key']),
    index('unique_song_request_public_id', true, ['public_id']),
    index('unique_song_request_queue_order', true, ['session_id', 'queue_order']),
    index('unique_song_request_source_event', true, ['source_event_id'])
  ], [
    foreignKey('fk_song_request_session', ['session_id'], 'live_sessions', ['id'], 'SET NULL'),
    foreignKey('fk_song_request_song', ['matched_song_id'], 'songs', ['id'], 'SET NULL'),
    foreignKey('fk_song_request_user', ['requester_user_id'], 'users', ['id'], 'SET NULL')
  ]),

  song_request_history: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    column('request_id', 'bigint unsigned'),
    textColumn('from_status', REQUEST_STATUSES, { nullable: true }),
    textColumn('to_status', REQUEST_STATUSES, { nullable: true }),
    textColumn('action', 'varchar(50)'),
    column('actor_user_id', 'int', { nullable: true }),
    textColumn('reason', 'varchar(500)', { nullable: true }),
    column('metadata', 'json', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' })
  ], [
    index('PRIMARY', true, ['id']),
    index('idx_song_request_history_actor', false, ['actor_user_id', 'created_at']),
    index('idx_song_request_history_request', false, ['request_id', 'created_at', 'id'])
  ], [
    foreignKey('fk_song_request_history_actor', ['actor_user_id'], 'users', ['id'], 'SET NULL'),
    foreignKey('fk_song_request_history_request', ['request_id'], 'song_requests', ['id'])
  ]),

  song_aliases: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    column('song_id', 'int'),
    binaryTextColumn('alias', 'varchar(512)'),
    binaryTextColumn('normalized_alias', 'varchar(512)'),
    binaryTextColumn('script_key', 'varchar(512)'),
    binaryTextColumn('loose_candidate_key', 'varchar(512)'),
    column('created_by_user_id', 'int', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('updated_at', 'timestamp(3)', {
      default: 'CURRENT_TIMESTAMP(3)',
      on_update: 'CURRENT_TIMESTAMP(3)'
    })
  ], [
    index('PRIMARY', true, ['id']),
    index('fk_song_alias_creator', false, ['created_by_user_id']),
    index('idx_song_alias_normalized', false, ['normalized_alias', 'song_id']),
    index('idx_song_alias_script', false, ['script_key', 'song_id']),
    index('unique_song_alias_equivalent', true, ['song_id', 'loose_candidate_key'])
  ], [
    foreignKey('fk_song_alias_creator', ['created_by_user_id'], 'users', ['id'], 'SET NULL'),
    foreignKey('fk_song_alias_song', ['song_id'], 'songs', ['id'], 'CASCADE')
  ]),

  song_request_policies: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    column('song_id', 'int'),
    column('temporarily_blocked', 'tinyint(1)', { default: 0 }),
    textColumn('public_reason', 'varchar(200)', { nullable: true }),
    textColumn('internal_note', 'varchar(500)', { nullable: true }),
    column('blocked_until', 'datetime(3)', { nullable: true }),
    column('released_at', 'datetime(3)', { nullable: true }),
    column('special_event_tag_id', 'int', { nullable: true }),
    column('duration_override_seconds', 'int unsigned', { nullable: true }),
    column('created_by_user_id', 'int', { nullable: true }),
    column('updated_by_user_id', 'int', { nullable: true }),
    column('released_by_user_id', 'int', { nullable: true }),
    column('version', 'int unsigned', { default: 0 }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('updated_at', 'timestamp(3)', {
      default: 'CURRENT_TIMESTAMP(3)',
      on_update: 'CURRENT_TIMESTAMP(3)'
    })
  ], [
    index('PRIMARY', true, ['id']),
    index('idx_song_request_policy_block', false, ['temporarily_blocked', 'blocked_until']),
    index('idx_song_request_policy_creator', false, ['created_by_user_id']),
    index('idx_song_request_policy_event_tag', false, ['special_event_tag_id']),
    index('idx_song_request_policy_releaser', false, ['released_by_user_id']),
    index('idx_song_request_policy_updater', false, ['updated_by_user_id']),
    index('unique_song_request_policy_song', true, ['song_id'])
  ], [
    foreignKey('fk_song_request_policy_creator', ['created_by_user_id'], 'users', ['id'], 'SET NULL'),
    foreignKey('fk_song_request_policy_event_tag', ['special_event_tag_id'], 'tags', ['id'], 'SET NULL'),
    foreignKey('fk_song_request_policy_releaser', ['released_by_user_id'], 'users', ['id'], 'SET NULL'),
    foreignKey('fk_song_request_policy_song', ['song_id'], 'songs', ['id'], 'CASCADE'),
    foreignKey('fk_song_request_policy_updater', ['updated_by_user_id'], 'users', ['id'], 'SET NULL')
  ]),

  song_request_details: table([
    column('request_id', 'bigint unsigned'),
    textColumn('canonical_match_method', 'varchar(32)'),
    textColumn('reason_code', 'varchar(50)', { nullable: true }),
    textColumn('public_reason', 'varchar(200)', { nullable: true }),
    textColumn('internal_note', 'varchar(500)', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('updated_at', 'timestamp(3)', {
      default: 'CURRENT_TIMESTAMP(3)',
      on_update: 'CURRENT_TIMESTAMP(3)'
    })
  ], [
    index('PRIMARY', true, ['request_id']),
    index('idx_song_request_detail_reason', false, ['reason_code', 'updated_at'])
  ], [
    foreignKey('fk_song_request_detail_request', ['request_id'], 'song_requests', ['id'], 'CASCADE')
  ]),

  obs_overlay_events: table([
    column('sequence', 'bigint unsigned', { auto_increment: true }),
    asciiColumn('public_id', 'char(36)'),
    textColumn(
      'event_type',
      "enum('gift_thanks','guard_alert','cotton_candy','ai_bubble','notice')"
    ),
    textColumn('source', "enum('manual','simulator','bilibili','ai')"),
    column('payload_json', 'json'),
    column('display_duration_ms', 'int unsigned'),
    asciiColumn('idempotency_key', 'varchar(128)'),
    column('created_by_user_id', 'int', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
    column('replay_until', 'datetime(3)'),
    column('dismissed_at', 'datetime(3)', { nullable: true })
  ], [
    index('PRIMARY', true, ['sequence']),
    index('idx_obs_overlay_created', false, ['created_at', 'sequence']),
    index('idx_obs_overlay_creator', false, ['created_by_user_id']),
    index('idx_obs_overlay_replay', false, ['dismissed_at', 'replay_until', 'sequence']),
    index('unique_obs_overlay_public_id', true, ['public_id']),
    index('unique_obs_overlay_source_idempotency', true, ['source', 'idempotency_key'])
  ], [
    foreignKey('fk_obs_overlay_creator', ['created_by_user_id'], 'users', ['id'], 'SET NULL')
  ]),

  viewer_identity_audit: table([
    column('id', 'bigint unsigned', { auto_increment: true }),
    column('binding_id', 'int', { nullable: true }),
    column('target_user_id', 'int'),
    column('bilibili_uid', 'bigint', { nullable: true }),
    textColumn(
      'action',
      "enum('sync_confirmed','sync_failed','listener_confirmed','manual_created','manual_updated','manual_revoked','manual_expired','manual_overridden','role_recomputed')"
    ),
    column('actor_user_id', 'int', { nullable: true }),
    textColumn(
      'actor_role',
      "enum('fan_club','captain','admiral','governor','streamer','admin')",
      { nullable: true }
    ),
    textColumn(
      'old_role',
      "enum('fan_club','captain','admiral','governor','streamer','admin')",
      { nullable: true }
    ),
    textColumn(
      'new_role',
      "enum('fan_club','captain','admiral','governor','streamer','admin')",
      { nullable: true }
    ),
    textColumn(
      'source',
      "enum('automatic','transient_qr','server_provider','official_listener','manual_fallback')"
    ),
    textColumn('reason', 'varchar(500)', { nullable: true }),
    column('valid_until', 'datetime(3)', { nullable: true }),
    asciiColumn('event_key', 'varchar(255)', { nullable: true }),
    column('created_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' })
  ], [
    index('PRIMARY', true, ['id']),
    index('idx_viewer_identity_actor', false, ['actor_user_id', 'created_at']),
    index('idx_viewer_identity_binding', false, ['binding_id', 'created_at']),
    index('idx_viewer_identity_target', false, ['target_user_id', 'created_at']),
    index('unique_viewer_identity_event', true, ['event_key'])
  ], [
    foreignKey(
      'fk_viewer_identity_binding',
      ['binding_id'],
      'user_bilibili_bindings',
      ['id'],
      'SET NULL'
    ),
    foreignKey('fk_viewer_identity_target', ['target_user_id'], 'users', ['id']),
    foreignKey('fk_viewer_identity_actor', ['actor_user_id'], 'users', ['id'], 'SET NULL')
  ])
});

const ledgerContract = Object.freeze(table([
  asciiColumn('version', 'varchar(64)'),
  textColumn('name', 'varchar(255)'),
  asciiColumn('checksum', 'char(64)'),
  textColumn('state', "enum('applied')"),
  column('applied_at', 'timestamp(3)', { default: 'CURRENT_TIMESTAMP(3)' })
], [
  index('PRIMARY', true, ['version'])
]));

const migrationContracts = Object.freeze({
  '202607240001': Object.freeze({
    name: 'phase_4b_4c_live_control',
    kind: 'tables',
    depends_on: Object.freeze([]),
    tables: Object.freeze([
      'live_events',
      'live_sessions',
      'song_requests',
      'song_request_history',
      'song_aliases'
    ]),
    indexes: Object.freeze([])
  }),
  '202607240002': Object.freeze({
    name: 'live_events_received_at_index',
    kind: 'indexes',
    depends_on: Object.freeze(['202607240001']),
    tables: Object.freeze([]),
    indexes: Object.freeze([
      Object.freeze({
        table: 'live_events',
        name: 'idx_live_event_received',
        unique: false,
        columns: Object.freeze(['received_at', 'id'])
      })
    ])
  }),
  '202607240003': Object.freeze({
    name: 'phase_4i_song_request_experience',
    kind: 'tables_and_indexes',
    depends_on: Object.freeze(['202607240001', '202607240002']),
    tables: Object.freeze(['song_request_policies', 'song_request_details']),
    indexes: Object.freeze([
      Object.freeze({
        table: 'user_bilibili_bindings',
        name: 'unique_bound_open_id',
        unique: true,
        columns: Object.freeze(['bilibili_open_id'])
      }),
      Object.freeze({
        table: 'song_aliases',
        name: 'unique_song_alias_normalized',
        unique: true,
        columns: Object.freeze(['normalized_alias'])
      }),
      Object.freeze({
        table: 'song_aliases',
        name: 'unique_song_alias_script',
        unique: true,
        columns: Object.freeze(['script_key'])
      })
    ])
  }),
  '202607240004': Object.freeze({
    name: 'phase_4j_obs_overlays',
    kind: 'tables',
    depends_on: Object.freeze(['202607240003']),
    tables: Object.freeze(['obs_overlay_events']),
    indexes: Object.freeze([])
  }),
  '202607240005': Object.freeze({
    name: 'six_role_rbac',
    kind: 'schema_change',
    schema_change: 'users_role',
    depends_on: Object.freeze(['202607240004']),
    tables: Object.freeze([]),
    indexes: Object.freeze([])
  }),
  '202607240006': Object.freeze({
    name: 'viewer_identity_sync',
    kind: 'tables_and_indexes',
    schema_change: 'viewer_identity_sync',
    depends_on: Object.freeze(['202607240005']),
    tables: Object.freeze(['viewer_identity_audit']),
    indexes: Object.freeze([
      Object.freeze({
        table: 'user_bilibili_bindings',
        name: 'idx_binding_identity_due',
        unique: false,
        columns: Object.freeze(['identity_sync_status', 'next_sync_at'])
      }),
      Object.freeze({
        table: 'user_bilibili_bindings',
        name: 'idx_binding_guard_expiry',
        unique: false,
        columns: Object.freeze(['guard_expires_at'])
      }),
      Object.freeze({
        table: 'user_bilibili_bindings',
        name: 'idx_binding_manual_expiry',
        unique: false,
        columns: Object.freeze(['manual_expires_at'])
      })
    ])
  }),
  '202607240007': Object.freeze({
    name: 'official_live_ai',
    kind: 'tables',
    depends_on: Object.freeze(['202607240006']),
    tables: Object.freeze([
      'official_live_event_dedup',
      'official_ai_memory'
    ]),
    indexes: Object.freeze([])
  })
});

const legacyTables = Object.freeze([
  'users',
  'settings',
  'permissions',
  'email_verification_codes',
  'playlists',
  'songs',
  'tags',
  'song_tags',
  'marshmallows',
  'marshmallow_reads',
  'user_bilibili_bindings',
  'point_wallets',
  'point_accounts',
  'point_account_transactions',
  'bilibili_point_events',
  'prizes',
  'prize_images',
  'prize_options',
  'prize_cart_items',
  'shipping_addresses',
  'prize_orders',
  'redemptions'
]);

module.exports = {
  ledgerContract,
  legacyTables,
  migrationContracts,
  targetContracts
};
