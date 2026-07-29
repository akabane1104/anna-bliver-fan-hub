SET @users_role_collation := (
  SELECT COLLATION_NAME
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'role'
);

SET @users_role_expand_sql := CONCAT(
  'ALTER TABLE users MODIFY role ',
  'ENUM(''user'',''premium'',''admin'',''fan_club'',''captain'',''admiral'',''governor'',''streamer'') ',
  'CHARACTER SET utf8mb4 COLLATE ',
  @users_role_collation,
  ' NOT NULL DEFAULT ''fan_club'''
);
PREPARE users_role_statement FROM @users_role_expand_sql;
EXECUTE users_role_statement;
DEALLOCATE PREPARE users_role_statement;

UPDATE users SET role = 'fan_club' WHERE role = 'user';
UPDATE users SET role = 'streamer' WHERE role = 'premium';

SET @users_role_finalize_sql := CONCAT(
  'ALTER TABLE users MODIFY role ',
  'ENUM(''fan_club'',''captain'',''admiral'',''governor'',''streamer'',''admin'') ',
  'CHARACTER SET utf8mb4 COLLATE ',
  @users_role_collation,
  ' NOT NULL DEFAULT ''fan_club'''
);
PREPARE users_role_statement FROM @users_role_finalize_sql;
EXECUTE users_role_statement;
DEALLOCATE PREPARE users_role_statement;
