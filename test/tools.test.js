const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findPackage, resolveBin, resolvePlaywright, toolEnv, PACKAGE_ROOT, PACKAGE_NODE_MODULES } = require('../lib/tools');
const { mergeHtmlValidateConfig } = require('../lib/runtime');

function makeTree(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-tools-')));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('resolveBin finds the package\'s own tools as absolute paths', () => {
  for (const [name, bin] of [['stylelint', 'stylelint'], ['html-validate', 'html-validate'], ['@playwright/test', 'playwright']]) {
    const tool = resolveBin(name, bin);
    assert.ok(path.isAbsolute(tool.bin));
    assert.ok(fs.existsSync(tool.bin), `${tool.bin} does not exist`);
    assert.match(tool.version, /^\d+\.\d+\.\d+/);
  }
});

test('resolveBin reads manifests from disk, so an "exports" map cannot block it', () => {
  // @axe-core/playwright refuses require('@axe-core/playwright/package.json')
  assert.ok(findPackage('@axe-core/playwright', PACKAGE_ROOT));
  assert.throws(() => resolveBin('definitely-not-installed', 'x'), /not installed/);
  assert.throws(() => resolveBin('@axe-core/playwright', 'nope'), /no "nope" executable/);
});

test('Playwright: the site\'s copy wins when it has one, else the package\'s', () => {
  const siteWithCopy = makeTree({
    'node_modules/@playwright/test/package.json': JSON.stringify({ version: '1.50.0', bin: { playwright: 'cli.js' } }),
    'node_modules/@playwright/test/cli.js': '',
    'hugo-validator/.runtime/tests/.keep': '',
  });
  const fromSite = resolvePlaywright(path.join(siteWithCopy, 'hugo-validator', '.runtime', 'tests'));
  assert.strictEqual(fromSite.version, '1.50.0');
  assert.strictEqual(fromSite.fromSite, true);
  assert.ok(fromSite.bin.startsWith(siteWithCopy));

  const bareSite = makeTree({ 'hugo-validator/.runtime/tests/.keep': '' });
  const fromPackage = resolvePlaywright(path.join(bareSite, 'hugo-validator', '.runtime', 'tests'));
  assert.strictEqual(fromPackage.fromSite, false);
  assert.ok(fromPackage.bin.startsWith(fs.realpathSync(PACKAGE_ROOT)));
});

test('toolEnv puts the package\'s node_modules on NODE_PATH and keeps an existing value', () => {
  assert.strictEqual(toolEnv({}).NODE_PATH, PACKAGE_NODE_MODULES);
  assert.strictEqual(toolEnv({ NODE_PATH: '/x' }).NODE_PATH, `${PACKAGE_NODE_MODULES}${path.delimiter}/x`);
  assert.strictEqual(toolEnv({ A: '1' }, { B: '2' }).B, '2');
});

test('html-validate config: base merged in, site rules win, paths made absolute', () => {
  const base = { extends: ['html-validate:recommended'], rules: { 'void-style': 'off', 'no-inline-style': 'error' } };
  const site = {
    extends: ['hugo-validator/configs/htmlvalidate', './local-rules.json'],
    rules: { 'no-inline-style': 'off' },
    elements: ['html5', './elements.json'],
  };
  const merged = mergeHtmlValidateConfig(site, base, '/site/hugo-validator');
  assert.deepStrictEqual(merged.extends, ['html-validate:recommended', '/site/hugo-validator/local-rules.json']);
  assert.deepStrictEqual(merged.rules, { 'void-style': 'off', 'no-inline-style': 'off' });
  assert.deepStrictEqual(merged.elements, ['html5', '/site/hugo-validator/elements.json']);
  assert.strictEqual(merged.root, true);

  // A site that does not extend the package's base gets none of it
  const standalone = mergeHtmlValidateConfig({ extends: ['html-validate:standard'], rules: {} }, base, '/site/hugo-validator');
  assert.deepStrictEqual(standalone.extends, ['html-validate:standard']);
  assert.deepStrictEqual(standalone.rules, {});
});
