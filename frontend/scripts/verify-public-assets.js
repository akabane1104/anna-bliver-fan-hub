'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const publicRoot = path.join(__dirname, '..', 'public');
const indexPath = path.join(publicRoot, 'index.html');
const footerPath = path.join(__dirname, '..', 'src', 'components', 'Footer.js');
const entryPath = path.join(__dirname, '..', 'src', 'index.js');

const index = fs.readFileSync(indexPath, 'utf8');
const footer = fs.readFileSync(footerPath, 'utf8');
const entry = fs.readFileSync(entryPath, 'utf8');

const publicAssets = fs.readdirSync(path.join(publicRoot, 'assets'))
  .filter((name) => /^[a-f0-9]{8}\.js$/.test(name))
  .map((name) => `assets/${name}`);
if (publicAssets.length !== 2) {
  throw new Error('Expected exactly two opaque public runtime assets.');
}

const decodedEntryValues = [...entry.matchAll(/unpack\(\[([\d,\s]+)\]\)/g)]
  .map((match) => String.fromCharCode(...match[1].split(',').map((value) => Number(value.trim()) ^ 93)));
const runtimeAssets = publicAssets.map((relativePath) => {
  const bytes = fs.readFileSync(path.join(publicRoot, ...relativePath.split('/')));
  const integrity = `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;
  if (!decodedEntryValues.includes(relativePath) || !decodedEntryValues.includes(integrity)) {
    throw new Error(`Runtime path or integrity hash is not encoded for ${relativePath}.`);
  }
  return bytes;
});
if (!entry.includes('loadPrimaryPublicRuntime') || !entry.includes('script.dataset.uiRuntime = marker')) {
  throw new Error('Primary protected runtime loader is missing.');
}
if (!entry.includes('requestIdleCallback') || !entry.includes("appendRuntimeAsset(runtimeAssets.continuity, 'r8', true)")) {
  throw new Error('Secondary runtime health probe is missing.');
}
if (!entry.includes('isObsOutputPath(window.location.pathname)')) {
  throw new Error('OBS output attribution exemption is missing.');
}

for (const forbidden of [
  'Linus_Lieu',
  'github.com/LinusLieu',
  'annapiggy-logo.png'
]) {
  if (runtimeAssets.some((asset) => asset.includes(Buffer.from(forbidden)))) {
    throw new Error(`Protected public assets contain unexpected plaintext: ${forbidden}`);
  }
  if (footer.includes(forbidden) || entry.includes(forbidden) || index.includes(forbidden)) {
    throw new Error(`Public entry source contains unexpected plaintext: ${forbidden}`);
  }
}

if (runtimeAssets.some((asset) => asset.length < 100_000)) {
  throw new Error('Protected public assets are unexpectedly small.');
}
console.log(`Protected public assets verified (${runtimeAssets.map((asset) => `${asset.length} bytes`).join('; ')}).`);
