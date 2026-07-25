#!/usr/bin/env node

const { safeErrorCode, listenerError } = require('./errors');
const { runDryRun } = require('./dryRun');
const { createProductionRuntime } = require('./productionRuntime');
const { createServiceRuntime } = require('./serviceRuntime');

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (!['dry-run', 'start', 'service'].includes(mode)) {
    throw listenerError('invalid_listener_mode');
  }
  let json = false;
  let source = null;
  for (const token of rest) {
    if (token === '--json') {
      if (json) throw listenerError('duplicate_argument');
      json = true;
      continue;
    }
    if (token === '--secret' || token.startsWith('--secret=')) {
      throw listenerError('secret_argument_forbidden');
    }
    if (
      token === '--access-key-secret' ||
      token.startsWith('--access-key-secret=') ||
      token === '--identity-code' ||
      token.startsWith('--identity-code=')
    ) {
      throw listenerError('secret_argument_forbidden');
    }
    if (token === '--source=bilibili-official') {
      if (source) throw listenerError('duplicate_argument');
      source = 'bilibili-official';
      continue;
    }
    throw listenerError('invalid_argument');
  }
  if (mode !== 'start' && source) throw listenerError('invalid_argument');
  if (mode === 'start' && !source) throw listenerError('invalid_argument');
  return { mode, json, source };
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
    processLike = process,
    env = process.env,
    dryRun = runDryRun,
    productionRuntimeFactory = createProductionRuntime,
    serviceRuntimeFactory = createServiceRuntime
  } = {}
) {
  const wantsJson = argv.includes('--json');
  try {
    const options = parseArguments(argv);
    if (['start', 'service'].includes(options.mode)) {
      const runtime = options.mode === 'service'
        ? serviceRuntimeFactory({ env })
        : productionRuntimeFactory({
          source: options.source,
          env
        });
      let resolveStopped;
      const stopped = new Promise((resolve) => {
        resolveStopped = resolve;
      });
      const handlers = installShutdownHandlers({
        processLike,
        async shutdown() {
          await runtime.stop();
          resolveStopped();
        }
      });
      try {
        await runtime.start();
        printResult({
          status: options.mode === 'service'
            ? runtime.snapshot().state
            : 'running',
          source: options.source || 'bilibili-official'
        }, options.json, stdout);
        await stopped;
        return Number(processLike.exitCode || 0);
      } catch (error) {
        await runtime.stop().catch(() => {});
        throw error;
      } finally {
        handlers.dispose();
      }
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
