const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dockerfilePath = path.resolve(__dirname, '..', 'Dockerfile');

test('Listener image installs shared schema dependencies at the app root', () => {
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  const installRoot = dockerfile.indexOf('WORKDIR /app\n');
  const packageCopy = dockerfile.indexOf(
    'COPY services/bilibili-listener/package.json ' +
      'services/bilibili-listener/package-lock.json ./'
  );
  const sourceCopy = dockerfile.indexOf(
    'COPY --chown=node:node services/bilibili-listener/src ' +
      './services/bilibili-listener/src'
  );
  const runtimeRoot = dockerfile.indexOf(
    'WORKDIR /app/services/bilibili-listener'
  );

  assert.ok(installRoot >= 0);
  assert.ok(packageCopy > installRoot);
  assert.ok(sourceCopy > packageCopy);
  assert.ok(runtimeRoot > sourceCopy);
  assert.match(dockerfile, /USER node/);
});
