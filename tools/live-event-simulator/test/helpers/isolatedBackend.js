const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../../../../backend');
const { app } = require(path.join(backendRoot, 'src/server.js'));
const database = require(path.join(backendRoot, 'src/config/database.js'));

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (process.send) process.send({ type: 'ready', port: address.port });
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  await database.end();
  process.exit(0);
}

process.on('message', (message) => {
  if (message?.type === 'shutdown') {
    close().catch(() => process.exit(1));
  }
});
process.on('SIGTERM', () => {
  close().catch(() => process.exit(1));
});
