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
