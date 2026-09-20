const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deepMerge, loadConfig, getDefaultConfig } = require('../lib/config');

test('deepMerge merges objects and replaces arrays', () => {
  const merged = deepMerge(
    { a: { x: 1, y: 2 }, list: [1, 2], keep: true },
    { a: { y: 3 }, list: [9] }
  );
  assert.deepStrictEqual(merged, { a: { x: 1, y: 3 }, list: [9], keep: true });
});

test('defaults: no dead htmlValidation.pattern, AA touch target', () => {
  const defaults = getDefaultConfig();
  assert.strictEqual(defaults.htmlValidation.pattern, undefined);
  assert.strictEqual(defaults.interaction.minTouchTarget, 24);
  assert.strictEqual(defaults.links.failOnExternal, false);
});

test('loadConfig deep merges the user config over defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-cfg-'));
  fs.mkdirSync(path.join(root, 'hugo-validator'));
  fs.writeFileSync(
    path.join(root, 'hugo-validator', 'hugo-validator.config.js'),
    "module.exports = { siteUrl: 'https://blog.test', interaction: { minTouchTarget: 44 } };"
  );
  const config = loadConfig(root);
  assert.strictEqual(config.siteUrl, 'https://blog.test');
  assert.strictEqual(config.interaction.minTouchTarget, 44);
  assert.strictEqual(config.interaction.navSelector, '.site-nav a');
});
