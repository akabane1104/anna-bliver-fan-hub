#!/usr/bin/env node

const { safeErrorCode, listenerError } = require('./errors');
const { runDryRun } = require('./dryRun');
const { createProductionAdapter } = require('./sourceAdapter');

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (!['dry-run', 'start'].includes(mode)) throw listenerError('invalid_listener_mode');
  let json = false;
  for (const token of rest) {
    if (token === '--json') {
      if (json) throw listenerError('duplicate_argument');
      json = true;
      continue;
    }
    if (token === '--secret' || token.startsWith('--secret=')) {
      throw listenerError('secret_argument_forbidden');
    }
    throw listenerError('invalid_argument');
  }
  return { mode, json };
}

function printResult(value, json, stdout = process.stdout) {
  if (json) {
    stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    stdout.write(`${key}=${item}\n`);
  }
}

function installShutdownHandlers({
  shutdown,
  processLike = process
}) {
  let shutdownPromise = null;
  const invoke = (exitCode) => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve()
        .then(shutdown)
        .then(
          () => {
            processLike.exitCode = exitCode;
          },
          () => {
            processLike.exitCode = 1;
          }
        );
    }
    return shutdownPromise;
  };
  const onSigint = () => invoke(130);
  const onSigterm = () => invoke(143);
  const onFatal = () => invoke(1);
  processLike.once('SIGINT', onSigint);
  processLike.once('SIGTERM', onSigterm);
  processLike.once('uncaughtException', onFatal);
  processLike.once('unhandledRejection', onFatal);
  return {
    invoke,
    dispose() {
      processLike.off('SIGINT', onSigint);
      processLike.off('SIGTERM', onSigterm);
      processLike.off('uncaughtException', onFatal);
      processLike.off('unhandledRejection', onFatal);
    }
  };
}

async function main(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    dryRun = runDryRun,
    productionAdapterFactory = createProductionAdapter
  } = {}
) {
  const wantsJson = argv.includes('--json');
  try {
    const options = parseArguments(argv);
    if (options.mode === 'start') {
      productionAdapterFactory();
      throw listenerError('bilibili_adapter_not_implemented');
    }
    const result = await dryRun();
    printResult(result, options.json, stdout);
    return 0;
  } catch (error) {
    printResult({
      status: 'failed',
      error_code: safeErrorCode(error)
    }, wantsJson, stdout);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  installShutdownHandlers,
  main,
  parseArguments,
  printResult
};
