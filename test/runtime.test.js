const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { prepareRuntime, renderPlaywrightConfig, resolveServerCommand, resolveBrowserExecutable } = require('../lib/runtime');
const { createServer, resolveRequest } = require('../lib/serve');
const { findLegacy, isValidatorTestsDir } = require('../lib/migrate');
const { parseVersion, versionAtLeast, satisfiesCaret } = require('../lib/doctor');
const { parseSsPids, parsePidList, findListeners } = require('../lib/validate');
const { getDefaultConfig } = require('../lib/config');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-rt-'));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('prepareRuntime syncs tests and config, and keeps test-results', () => {
  const root = makeTree({
    'hugo-validator/.runtime/tests/stale.spec.ts': 'old',
    'hugo-validator/.runtime/test-results/.last-run.json': '{}',
  });
  const runtime = prepareRuntime(getDefaultConfig(), root, {});

  assert.ok(runtime.testFiles.includes('helpers.ts'));
  assert.ok(fs.existsSync(path.join(runtime.testsDir, 'links.spec.ts')));
  assert.ok(!fs.existsSync(path.join(runtime.testsDir, 'stale.spec.ts')), 'stale tests are removed');
  assert.ok(fs.existsSync(path.join(runtime.runtimeDir, 'test-results', '.last-run.json')), '--last-failed state survives');
  assert.ok(fs.existsSync(runtime.configPath));
  assert.strictEqual(runtime.configArg, path.join('hugo-validator', '.runtime', 'playwright.config.ts'));
});

test('generated Playwright config: built-in server by default, overrides honoured', () => {
  const root = '/site';
  const defaults = renderPlaywrightConfig({ ...getDefaultConfig(), testServerPort: 4321 }, root, {});
  assert.match(defaults, /localhost:4321/);
  assert.match(defaults, /serve\.js/);
  assert.match(defaults, /--port 4321/);
  assert.doesNotMatch(defaults, /python/);
  assert.doesNotMatch(defaults, /executablePath/);

  const custom = renderPlaywrightConfig({ ...getDefaultConfig(), testServerCommand: 'npx serve ../public' }, root, {});
  assert.match(custom, /npx serve \.\.\/public/);
  assert.match(custom, /cwd: "\/site\/hugo-validator"/, 'custom commands still run from <site>/hugo-validator');

  assert.strictEqual(resolveServerCommand({ testServerCommand: 'x', testServerPort: 1 }, root), 'x');
});

test('browser override: env beats config beats default', () => {
  assert.strictEqual(resolveBrowserExecutable({ browserExecutable: null }, {}), null);
  assert.strictEqual(resolveBrowserExecutable({ browserExecutable: '/usr/bin/chromium' }, {}), '/usr/bin/chromium');
  assert.strictEqual(resolveBrowserExecutable({ browserExecutable: '/a' }, { HUGO_VALIDATOR_BROWSER: '/b' }), '/b');
  const rendered = renderPlaywrightConfig(getDefaultConfig(), '/site', { HUGO_VALIDATOR_BROWSER: '/usr/bin/chromium' });
  assert.match(rendered, /executablePath: "\/usr\/bin\/chromium"/);
});

test('static server: index, redirect, 404 page, no listing, no traversal', async () => {
  const root = makeTree({
    'index.html': 'home',
    'posts/a/index.html': 'post a',
    'images/pic.png': 'png',
    '404.html': 'custom not found',
    'files/doc.pdf': 'pdf',
  });
  assert.deepStrictEqual(resolveRequest(root, '/posts/a'), { redirect: '/posts/a/' });
  assert.deepStrictEqual(resolveRequest(root, '/images/'), { notFound: true }, 'folder without index is 404, never a listing');
  assert.deepStrictEqual(resolveRequest(root, '/../../etc/passwd'), { notFound: true });
  assert.deepStrictEqual(resolveRequest(root, '/%2e%2e/%2e%2e/etc/passwd'), { notFound: true });

  const server = createServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (url) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${url}`, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });

  try {
    assert.deepStrictEqual(await get('/'), { status: 200, type: 'text/html; charset=utf-8', body: 'home' });
    assert.strictEqual((await get('/posts/a/')).body, 'post a');
    assert.strictEqual((await get('/posts/a')).status, 301);
    assert.strictEqual((await get('/files/doc.pdf')).type, 'application/pdf');
    const missing = await get('/nope/');
    assert.deepStrictEqual([missing.status, missing.body], [404, 'custom not found']);
    assert.strictEqual((await get('/images/')).status, 404);
  } finally {
    server.close();
  }
});

test('port tools: parsers and tool preference', () => {
  assert.deepStrictEqual(parseSsPids('LISTEN 0 4096 *:1313 *:* users:(("hugo",pid=4242,fd=7))'), [4242]);
  assert.deepStrictEqual(parseSsPids(''), []);
  assert.deepStrictEqual(parsePidList('123\n456\n'), [123, 456]);
  assert.deepStrictEqual(parsePidList(' 1313/tcp:  789 790'.replace(/^.*:/, '')), [789, 790]);
  assert.strictEqual(findListeners(59998, () => false), null, 'no tool available');
});

test('migrate only flags files that are recognisably the validator\'s', () => {
  const root = makeTree({
    'hugo-validator/tests/links.spec.ts': '',
    'hugo-validator/tests/helpers.ts': '',
    'hugo-validator/playwright.config.ts': '',
    'hugo-validator/.stylelintrc.json': '{}',
    '.stylelintrc.json': '{}',
    '.htmlvalidate.json': '{}', // no validator copy: must be left alone
    'tests/my-own.spec.ts': '', // the site's own tests: must be left alone
    'playwright.config.ts': 'export default {}', // not ours
    '.githooks/pre-commit': '#!/bin/sh\nnpm run validate:css\n',
    'scripts/validate.sh': 'exec .githooks/pre-commit',
    '.validation-reports/x/log': '',
  });
  const found = findLegacy(root).map(item => item.path).sort();
  assert.deepStrictEqual(found, [
    '.githooks/pre-commit',
    '.stylelintrc.json',
    '.validation-reports',
    'hugo-validator/playwright.config.ts',
    'hugo-validator/tests',
    'scripts/validate.sh',
  ]);
  assert.strictEqual(isValidatorTestsDir(path.join(root, 'tests')), false);

  const clean = makeTree({ '.githooks/pre-commit': 'npx hugo-validator validate --full\n' });
  assert.deepStrictEqual(findLegacy(clean), []);
});

test('doctor version helpers', () => {
  assert.deepStrictEqual(parseVersion('hugo v0.166.0+extended'), [0, 166, 0]);
  assert.ok(versionAtLeast([24, 21, 0], [22, 22, 0]));
  assert.ok(!versionAtLeast([22, 13, 0], [22, 22, 0]));
  assert.ok(satisfiesCaret('11.16.0', '^11.16.0'));
  assert.ok(satisfiesCaret('11.20.1', '^11.16.0'));
  assert.ok(!satisfiesCaret('10.5.0', '^11.16.0'));
  assert.ok(!satisfiesCaret('12.0.0', '^11.16.0'));
});
