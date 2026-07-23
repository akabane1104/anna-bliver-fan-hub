function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (/^current_timestamp(?:\(\d+\))?$/i.test(text)) return text.toUpperCase();
  return text;
}

function normalizeGenerationExpression(value) {
  if (!value) return null;
  return String(value)
    .toLowerCase()
    .replace(/_utf8mb4/g, '')
    .replace(/\\/g, '')
    .replace(/[`()\s]/g, '');
}

function normalizeColumn(row) {
  const extra = String(row.extra || '').toLowerCase();
  const onUpdateMatch = extra.match(/on update (current_timestamp(?:\(\d+\))?)/i);
  let generated = null;
  if (extra.includes('stored generated')) generated = 'STORED';
  if (extra.includes('virtual generated')) generated = 'VIRTUAL';
  return {
    name: row.column_name,
    type: String(row.column_type).toLowerCase(),
    nullable: row.is_nullable === 'YES',
    default: normalizeDefault(row.column_default),
    charset: row.character_set_name || null,
    collation: row.collation_name || null,
    auto_increment: extra.includes('auto_increment'),
    generated,
    generation_expression: normalizeGenerationExpression(row.generation_expression),
    on_update: onUpdateMatch ? onUpdateMatch[1].toUpperCase() : null
  };
}

function sortNamed(left, right) {
  return left.name.localeCompare(right.name, 'en');
}

function normalizeContract(contract) {
  return {
    engine: String(contract.engine).toUpperCase(),
    charset: contract.charset,
    collation: contract.collation,
    columns: contract.columns.map((item) => ({ ...item })),
    indexes: contract.indexes
      .map((item) => ({ ...item, columns: [...item.columns] }))
      .sort(sortNamed),
    foreign_keys: contract.foreign_keys
      .map((item) => ({
        ...item,
        columns: [...item.columns],
        referenced_columns: [...item.referenced_columns]
      }))
      .sort(sortNamed)
  };
}

function collectDifferences(expected, actual, path = '', output = []) {
  if (output.length >= 30) return output;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      output.push(`${path}: expected array`);
      return output;
    }
    if (expected.length !== actual.length) {
      output.push(`${path}.length: expected ${expected.length}, found ${actual.length}`);
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferences(expected[index], actual[index], `${path}[${index}]`, output);
    }
    return output;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') {
      output.push(`${path}: expected object`);
      return output;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const nextPath = path ? `${path}.${key}` : key;
      if (!(key in expected)) output.push(`${nextPath}: unexpected`);
      else if (!(key in actual)) output.push(`${nextPath}: missing`);
      else collectDifferences(expected[key], actual[key], nextPath, output);
      if (output.length >= 30) break;
    }
    return output;
  }
  if (expected !== actual) {
    output.push(`${path}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
  return output;
}

async function inspectTables(connection, databaseName, tableNames) {
  if (!tableNames.length) return {};
  const placeholders = tableNames.map(() => '?').join(', ');
  const parameters = [databaseName, ...tableNames];
  const [tableRows] = await connection.query(
    `SELECT
       t.TABLE_NAME AS table_name,
       t.ENGINE AS engine,
       t.TABLE_COLLATION AS table_collation,
       csa.CHARACTER_SET_NAME AS character_set_name
     FROM information_schema.TABLES t
     JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY csa
       ON csa.COLLATION_NAME = t.TABLE_COLLATION
     WHERE t.TABLE_SCHEMA = ?
       AND t.TABLE_NAME IN (${placeholders})`,
    parameters
  );
  const [columnRows] = await connection.query(
    `SELECT
       TABLE_NAME AS table_name,
       ORDINAL_POSITION AS ordinal_position,
       COLUMN_NAME AS column_name,
       COLUMN_TYPE AS column_type,
       IS_NULLABLE AS is_nullable,
       COLUMN_DEFAULT AS column_default,
       EXTRA AS extra,
       GENERATION_EXPRESSION AS generation_expression,
       CHARACTER_SET_NAME AS character_set_name,
       COLLATION_NAME AS collation_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN (${placeholders})
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    parameters
  );
  const [indexRows] = await connection.query(
    `SELECT
       TABLE_NAME AS table_name,
       INDEX_NAME AS index_name,
       NON_UNIQUE AS non_unique,
       SEQ_IN_INDEX AS seq_in_index,
       COLUMN_NAME AS column_name
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN (${placeholders})
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    parameters
  );
  const [foreignKeyRows] = await connection.query(
    `SELECT
       k.TABLE_NAME AS table_name,
       k.CONSTRAINT_NAME AS constraint_name,
       k.ORDINAL_POSITION AS ordinal_position,
       k.COLUMN_NAME AS column_name,
       k.REFERENCED_TABLE_NAME AS referenced_table_name,
       k.REFERENCED_COLUMN_NAME AS referenced_column_name,
       r.UPDATE_RULE AS update_rule,
       r.DELETE_RULE AS delete_rule
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
      AND r.TABLE_NAME = k.TABLE_NAME
      AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.TABLE_SCHEMA = ?
       AND k.TABLE_NAME IN (${placeholders})
       AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    parameters
  );

  const result = {};
  for (const row of tableRows) {
    result[row.table_name] = {
      engine: String(row.engine).toUpperCase(),
      charset: row.character_set_name,
      collation: row.table_collation,
      columns: [],
      indexes: [],
      foreign_keys: []
    };
  }
  for (const row of columnRows) {
    result[row.table_name]?.columns.push(normalizeColumn(row));
  }

  const indexes = new Map();
  for (const row of indexRows) {
    const key = `${row.table_name}\0${row.index_name}`;
    if (!indexes.has(key)) {
      indexes.set(key, {
        table: row.table_name,
        name: row.index_name,
        unique: Number(row.non_unique) === 0,
        columns: []
      });
    }
    indexes.get(key).columns.push(row.column_name);
  }
  for (const item of indexes.values()) {
    result[item.table]?.indexes.push({
      name: item.name,
      unique: item.unique,
      columns: item.columns
    });
  }

  const foreignKeys = new Map();
  for (const row of foreignKeyRows) {
    const key = `${row.table_name}\0${row.constraint_name}`;
    if (!foreignKeys.has(key)) {
      foreignKeys.set(key, {
        table: row.table_name,
        name: row.constraint_name,
        columns: [],
        referenced_table: row.referenced_table_name,
        referenced_columns: [],
        on_delete: row.delete_rule,
        on_update: row.update_rule
      });
    }
    const item = foreignKeys.get(key);
    item.columns.push(row.column_name);
    item.referenced_columns.push(row.referenced_column_name);
  }
  for (const item of foreignKeys.values()) {
    result[item.table]?.foreign_keys.push({
      name: item.name,
      columns: item.columns,
      referenced_table: item.referenced_table,
      referenced_columns: item.referenced_columns,
      on_delete: item.on_delete,
      on_update: item.on_update
    });
  }

  for (const tableName of Object.keys(result)) {
    result[tableName] = normalizeContract(result[tableName]);
  }
  return result;
}

function compareTableContract(expected, actual) {
  if (!actual) return { compatible: false, differences: ['table: missing'] };
  const differences = collectDifferences(normalizeContract(expected), normalizeContract(actual));
  return { compatible: differences.length === 0, differences };
}

module.exports = {
  collectDifferences,
  compareTableContract,
  inspectTables,
  normalizeContract,
  normalizeGenerationExpression
};
