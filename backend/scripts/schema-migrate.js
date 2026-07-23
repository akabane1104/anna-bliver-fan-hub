#!/usr/bin/env node

const {
  MigrationError,
  createMigrationRunner
} = require('../src/migrations/migrationRunner');

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 1) throw new MigrationError('migration_command_invalid');
  const [command] = argv;
  const runner = createMigrationRunner({ env });
  const result = await runner.run(command);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error instanceof MigrationError
      ? error.code
      : 'migration_unexpected_error';
    const details = error instanceof MigrationError ? error.details : [];
    process.stderr.write(`${JSON.stringify({ ok: false, code, details })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
