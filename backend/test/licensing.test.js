const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('repository metadata consistently declares GPL-3.0-or-later', () => {
  const license = read('LICENSE');
  const notice = read('NOTICE');
  const readme = read('README.md');
  const packages = [
    JSON.parse(read('package.json')),
    JSON.parse(read('frontend', 'package.json')),
    JSON.parse(read('backend', 'package.json')),
    JSON.parse(read('frontend', 'package-lock.json')).packages[''],
    JSON.parse(read('backend', 'package-lock.json')).packages['']
  ];

  assert.match(license, /^GNU GENERAL PUBLIC LICENSE\r?\nVersion 3, 29 June 2007/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  for (const packageMetadata of packages) {
    assert.equal(packageMetadata.license, 'GPL-3.0-or-later');
  }
  assert.match(notice, /Additional term under GNU GPLv3 section 7\(b\)/);
  assert.match(notice, /© 2026 Linus_Lieu/);
  assert.match(notice, /https:\/\/github\.com\/LinusLieu/);
  assert.match(readme, /GNU GPL v3/);
  assert.match(readme, /NOTICE/);
});

test('footer host has no plaintext fallback and uses an opaque integrity-locked runtime', () => {
  const footer = read('frontend', 'src', 'components', 'Footer.js');
  const index = read('frontend', 'public', 'index.html');
  const entry = read('frontend', 'src', 'index.js');
  const app = read('frontend', 'src', 'App.js');
  const policy = read('frontend', 'src', 'utils', 'obsRoutePolicy.js');
  const overlayStyles = read('frontend', 'src', 'pages', 'ObsOverlay.css');
  const verifier = read('frontend', 'scripts', 'verify-public-assets.js');
  const assetNames = fs.readdirSync(path.join(root, 'frontend', 'public', 'assets'))
    .filter((name) => /^[a-f0-9]{8}\.js$/.test(name));
  assert.equal(assetNames.length, 2);
  const generatedAssets = assetNames.map((name) => read('frontend', 'public', 'assets', name));

  assert.match(footer, /data-ui-slot="r7-4f1c"/);
  assert.match(footer, /<x-r7-slot/);
  assert.match(footer, /data-bilibili-uid=/);
  assert.doesNotMatch(footer, /© 2026|Linus_Lieu|github\.com\/LinusLieu|annapiggy-logo\.png/);
  assert.doesNotMatch(footer, /site-footer-fallback/);

  assert.doesNotMatch(index, /assets\/[a-f0-9]{8}\.js/);
  assert.doesNotMatch(index, /Linus_Lieu/);

  assert.match(verifier, /createHash\('sha384'\)/);
  assert.match(verifier, /Expected exactly two opaque public runtime assets/);
  assert.match(verifier, /OBS output attribution exemption is missing/);
  assert.match(entry, /requestIdleCallback/);
  assert.match(entry, /loadPrimaryPublicRuntime/);
  assert.match(entry, /appendRuntimeAsset\(runtimeAssets\.continuity, 'r8', true\)/);
  assert.match(entry, /script\.integrity = integrity/);
  assert.match(entry, /isObsOutputPath\(window\.location\.pathname\)/);
  assert.doesNotMatch(entry, /Linus_Lieu|github\.com\/LinusLieu|annapiggy-logo\.png|assets\/[a-f0-9]{8}\.js/);
  assert.match(policy, /pathname === '\/obs' \|\| pathname\.startsWith\('\/obs\/'\)/);
  assert.match(app, /if \(isObsOutputPath\(location\.pathname\)\)/);
  assert.match(app, /<Route path="\/obs" element=\{<ObsOverlayPreview \/>\} \/>/);
  assert.doesNotMatch(overlayStyles, /(?:footer|x-r7-slot)[^{]*\{[^}]*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|clip-path|left\s*:\s*-\d)/is);
  for (const generated of generatedAssets) {
    assert.ok(generated.length > 100_000, 'protected public runtime is unexpectedly small');
    assert.doesNotMatch(generated, /Linus_Lieu/);
    assert.doesNotMatch(generated, /github\.com\/LinusLieu/);
    assert.doesNotMatch(generated, /annapiggy-logo\.png/);
  }
});
