const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const roots = ['src', 'scripts', 'test']
  .map((entry) => path.join(packageRoot, entry));

function collectJavaScript(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...collectJavaScript(fullPath));
    if (entry.isFile() && entry.name.endsWith('.js')) output.push(fullPath);
  }
  return output;
}

const files = roots.flatMap(collectJavaScript).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
    timeout: 10000
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write(`Checked ${files.length} JavaScript files.\n`);
