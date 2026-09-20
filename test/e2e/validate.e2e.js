// End-to-end tests: run the real CLI against the sample site.
//
// Two jobs:
// 1. Prove the whole pipeline works (the green path).
// 2. Prove each validator still CATCHES what it exists to catch. Every
//    detection case injects one defect and asserts both the failure and the
//    specific finding. A dependency update that silently stops detecting a
//    problem fails here, which a "does it still run" test would never notice.
//
// The temp site has no tools of its own: only a link to this package. That is
// the layout where the package must supply everything.
//
// Needs: hugo (extended) on PATH and Playwright's Chromium installed.
// Run with: npm run test:e2e
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(PACKAGE_ROOT, 'test', 'fixture-site');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'hugo-validator.js');

/** Fresh copy of the sample site with the package linked in */
function makeSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-e2e-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(PACKAGE_ROOT, path.join(root, 'node_modules', 'hugo-validator'), 'dir');
  return root;
}

function cli(root, args) {
  const env = {
    ...process.env,
    // Hugo's dartsass transpiler needs a `sass` executable. sass-embedded provides one.
    PATH: `${path.join(PACKAGE_ROOT, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`,
    FORCE_COLOR: '0',
  };
  // Hook and CI variables change how a run behaves (forced full runs, one
  // worker, retries). The runs under test must behave like a developer's.
  for (const name of ['GIT_INDEX_FILE', 'PRE_COMMIT', 'GIT_HOOK', 'HUSKY_GIT_PARAMS', 'CI']) delete env[name];

  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 300000, env });
  // eslint-disable-next-line no-control-regex
  const output = `${result.stdout || ''}${result.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  return { status: result.status, output };
}

function edit(root, file, transform) {
  const full = path.join(root, file);
  fs.writeFileSync(full, transform(fs.readFileSync(full, 'utf8')));
}

function append(root, file, text) {
  edit(root, file, content => content + text);
}

function testResults(root) {
  const file = path.join(root, 'hugo-validator', '.runtime', 'test-results', 'results.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function failedTests(root) {
  return testResults(root).suites.flatMap(suite => suite.tests)
    .filter(t => t.status === 'failed')
    .map(t => ({ name: t.name, errors: t.errors.join('\n') }));
}

before(() => {
  const hugo = spawnSync('hugo', ['version'], { encoding: 'utf8' });
  assert.ok(!hugo.error && /extended/.test(hugo.stdout), 'these tests need Hugo extended on PATH');
});

test('green path: a clean site passes, then smart mode skips everything', () => {
  const root = makeSite();

  const first = cli(root, ['validate', '--full']);
  assert.strictEqual(first.status, 0, first.output);
  for (const line of ['✅ Hugo build', '✅ CSS validation', '✅ HTML validation', '✅ Playwright tests', '✅ All validations passed']) {
    assert.ok(first.output.includes(line), `missing "${line}" in:\n${first.output}`);
  }

  // Site holds no test code of its own: it is synced into the gitignored runtime folder
  assert.ok(fs.existsSync(path.join(root, 'hugo-validator', '.runtime', 'tests', 'links.spec.ts')));
  assert.ok(!fs.existsSync(path.join(root, 'hugo-validator', 'tests')));
  assert.ok(fs.existsSync(path.join(root, 'VALIDATION-REPORT.md')));

  const results = testResults(root);
  assert.strictEqual(results.failed, 0);
  assert.ok(results.passed >= 9, `expected the full suite to run, got ${results.passed} tests`);

  // The orphan page is linked from nowhere and must still be tested. The alias stub must not be.
  assert.match(first.output, /across 7 pages/, 'expected 7 real pages: home, posts, 2 posts, about, orphan, 404');

  const second = cli(root, ['validate']);
  assert.strictEqual(second.status, 0, second.output);
  assert.match(second.output, /no changes detected/);
  for (const stage of ['hugo', 'css', 'html', 'tests']) {
    assert.match(second.output, new RegExp(`${stage} \\(skipped - unchanged\\)`));
  }
});

test('smart mode reruns what a content change affects', () => {
  const root = makeSite();
  assert.strictEqual(cli(root, ['validate', '--full']).status, 0);

  append(root, 'content/about.md', '\nOne more paragraph.\n');
  const rerun = cli(root, ['validate']);
  assert.strictEqual(rerun.status, 0, rerun.output);
  assert.match(rerun.output, /✅ Hugo build/);
  assert.match(rerun.output, /css \(skipped - unchanged\)/);
  assert.match(rerun.output, /✅ HTML validation/);
  assert.match(rerun.output, /✅ Playwright tests/);
});

test('doctor and the test command work in a site with no tools of its own', () => {
  const root = makeSite();
  assert.strictEqual(cli(root, ['validate', '--only', 'hugo', '--full']).status, 0);

  const doctor = cli(root, ['doctor']);
  assert.strictEqual(doctor.status, 0, doctor.output);
  assert.match(doctor.output, /Ready to validate/);

  const links = cli(root, ['test', 'links']);
  assert.strictEqual(links.status, 0, links.output);
  assert.match(links.output, /all internal links return 200/);
});

// ---------------------------------------------------------------- detection

test('detects: Hugo warning fails the build, and later stages are skipped', () => {
  const root = makeSite();
  append(root, 'layouts/_default/single.html', '\n{{ warnf "deliberate warning from the e2e test" }}\n');

  const run = cli(root, ['validate', '--full']);
  assert.strictEqual(run.status, 1, run.output);
  assert.match(run.output, /❌ Hugo build failed/);
  assert.match(run.output, /deliberate warning from the e2e test/);
  assert.match(run.output, /html \(skipped - hugo build failed\)/);
  assert.match(run.output, /tests \(skipped - hugo build failed\)/);
  assert.match(run.output, /✅ CSS validation/, 'CSS does not depend on the build and still runs');
});

test('detects: SCSS rule violation', () => {
  const root = makeSite();
  append(root, 'assets/scss/main.scss', '\n.broken {\n  color: #ff;\n  colr: red;\n}\n');

  const run = cli(root, ['validate', '--only', 'css', '--full']);
  assert.strictEqual(run.status, 1, run.output);
  assert.match(run.output, /❌ CSS validation failed/);
  assert.match(run.output, /color-no-invalid-hex|property-no-unknown/);
});

test('detects: invalid HTML', () => {
  const root = makeSite();
  edit(root, 'layouts/_default/baseof.html', html =>
    html.replace('<footer class="site-footer">', '<div id="dup"></div><div id="dup"></div>\n<footer class="site-footer">'));

  const run = cli(root, ['validate', '--full']);
  assert.strictEqual(run.status, 1, run.output);
  assert.match(run.output, /❌ HTML validation failed/);
  assert.match(run.output, /no-dup-id/);
});

test('detects: accessibility violation (image without alt text)', () => {
  const root = makeSite();
  fs.writeFileSync(path.join(root, 'static', 'pixel.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
  // Through a layout, so html-validate is what we bypass and axe is what we test
  edit(root, 'layouts/_default/single.html', html => html.replace('{{ .Content }}', '{{ .Content }}\n<img src="/pixel.png" width="50" height="50">'));
  // html-validate flags the same defect. Switch its rule off so this case isolates axe.
  fs.writeFileSync(path.join(root, 'hugo-validator', '.htmlvalidate.json'),
    JSON.stringify({ extends: ['hugo-validator/configs/htmlvalidate'], rules: { 'wcag/h37': 'off' } }));

  const run = cli(root, ['validate', '--full']);
  assert.strictEqual(run.status, 1, run.output);
  assert.match(run.output, /✅ HTML validation/, 'the site rule override must be honoured');
  const failures = failedTests(root);
  assert.ok(failures.some(f => /WCAG/.test(f.name) && /image-alt/.test(f.errors)), JSON.stringify(failures, null, 2));
});

test('detects: broken internal link, missing download, and a folder without an index page', () => {
  const root = makeSite();
  fs.mkdirSync(path.join(root, 'static', 'images'));
  fs.writeFileSync(path.join(root, 'static', 'images', 'note.txt'), 'a folder with no index.html');
  append(root, 'content/about.md',
    '\n[gone](/no-such-page/) [missing file](/files/missing.pdf) [bare folder](/images/) [unpublished](https://fixture.test/not-yet/)\n');

  const run = cli(root, ['validate', '--full']);
  assert.strictEqual(run.status, 1, run.output);
  const failure = failedTests(root).find(f => /internal links/.test(f.name));
  assert.ok(failure, run.output);
  for (const target of ['/no-such-page/', '/files/missing.pdf', '/images/', '/not-yet/']) {
    assert.ok(failure.errors.includes(target), `${target} not reported in:\n${failure.errors}`);
  }
  assert.ok(!failure.errors.includes('/files/sample.pdf'), 'the download that exists must pass');
});

test('detects: small touch target and horizontal overflow', () => {
  const root = makeSite();
  edit(root, 'layouts/_default/single.html', html => html.replace('{{ .Content }}',
    '{{ .Content }}\n<button type="button" style="width:10px;height:10px;padding:0;border:0">x</button>\n<div style="width:2000px">wide</div>'));

  const run = cli(root, ['validate', '--full']);
  assert.strictEqual(run.status, 1, run.output);
  assert.match(run.output, /❌ Playwright tests failed/);
  const failures = failedTests(root);
  assert.ok(failures.some(f => /touch targets/.test(f.name) && /10x10px/.test(f.errors)), JSON.stringify(failures, null, 2));
  assert.ok(failures.some(f => /overflow on mobile/.test(f.name)), JSON.stringify(failures, null, 2));
  assert.ok(failures.some(f => /overflow on tablet/.test(f.name)), JSON.stringify(failures, null, 2));
});

// ------------------------------------------------------------ pre-commit hook

function git(root, args, extraPath = []) {
  const env = { ...process.env, FORCE_COLOR: '0' };
  // The hook needs `sass` for Hugo. extraPath goes first so a test can plant a decoy.
  env.PATH = [...extraPath, path.join(PACKAGE_ROOT, 'node_modules', '.bin'), process.env.PATH].join(path.delimiter);
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'CI']) delete env[name];
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 300000, env });
  // eslint-disable-next-line no-control-regex
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '') };
}

function makeGitSite() {
  const root = makeSite();
  // What `npm install` creates for a real site: the executable the hook runs
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'));
  fs.symlinkSync(CLI, path.join(root, 'node_modules', '.bin', 'hugo-validator'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'e2e@example.test'], ['config', 'user.name', 'e2e']]) {
    assert.strictEqual(git(root, args).status, 0);
  }
  const setup = cli(root, ['setup-hooks']);
  assert.strictEqual(setup.status, 0, setup.output);
  return root;
}

test('pre-commit hook: a commit runs the full pipeline through the local install', () => {
  const root = makeGitSite();
  const hook = fs.readFileSync(path.join(root, '.githooks', 'pre-commit'), 'utf8');
  assert.match(hook, /node_modules\/\.bin\/hugo-validator/);

  assert.strictEqual(git(root, ['add', '-A']).status, 0);
  const commit = git(root, ['commit', '-m', 'first']);
  assert.strictEqual(commit.status, 0, commit.output);
  assert.match(commit.output, /✅ All validations passed/);
  assert.doesNotMatch(commit.output, /skipped - unchanged/, 'a hook run is always a full run');
  assert.strictEqual(git(root, ['rev-list', '--count', 'HEAD']).output.trim(), '1');
});

test('pre-commit hook: without a local install the commit is blocked and npx is never called', () => {
  const root = makeGitSite();
  assert.strictEqual(git(root, ['add', '-A']).status, 0);
  assert.strictEqual(git(root, ['commit', '-m', 'first']).status, 0);

  // A fresh clone before `npm ci`: no node_modules
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });

  // A decoy npx, first on PATH. If the hook ever calls the package runner, this leaves a marker.
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-decoy-'));
  const marker = path.join(decoyDir, 'npx-was-called');
  fs.writeFileSync(path.join(decoyDir, 'npx'), `#!/bin/sh\necho "$@" > "${marker}"\nexit 0\n`, { mode: 0o755 });

  append(root, 'content/about.md', '\nA change to commit.\n');
  assert.strictEqual(git(root, ['add', '-A'], [decoyDir]).status, 0);
  const commit = git(root, ['commit', '-m', 'second'], [decoyDir]);

  assert.notStrictEqual(commit.status, 0, 'the commit must be blocked');
  assert.match(commit.output, /hugo-validator is not installed in this project\. Run: npm ci/);
  assert.ok(!fs.existsSync(marker), 'the hook called npx, which could reach the npm registry');
  assert.strictEqual(git(root, ['rev-list', '--count', 'HEAD']).output.trim(), '1', 'no second commit was created');
});

// ------------------------------------------------------------ init / migrate

test('init writes configuration only, and migrate removes only what is the validator\'s', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-init-'));
  fs.writeFileSync(path.join(root, 'hugo.yaml'), 'baseURL: "https://init.test/"\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo mine' } }));

  const init = cli(root, ['init', '--skip-hooks']);
  assert.strictEqual(init.status, 0, init.output);
  const created = fs.readdirSync(path.join(root, 'hugo-validator')).sort();
  assert.deepStrictEqual(created, ['.htmlvalidate.json', '.stylelintrc.json', 'hugo-validator.config.js']);
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.strictEqual(scripts.test, 'echo mine', 'an existing script is kept');
  assert.strictEqual(scripts.validate, 'hugo-validator validate');
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /hugo-validator\/\.runtime\//);
  assert.match(fs.readFileSync(path.join(root, 'hugo-validator', 'hugo-validator.config.js'), 'utf8'), /https:\/\/init\.test\//);

  // Legacy leftovers next to files that belong to the site
  fs.mkdirSync(path.join(root, 'hugo-validator', 'tests'));
  fs.writeFileSync(path.join(root, 'hugo-validator', 'tests', 'links.spec.ts'), '');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'my-own.spec.ts'), '');

  const preview = cli(root, ['migrate']);
  assert.match(preview.output, /Nothing was changed/);
  assert.ok(fs.existsSync(path.join(root, 'hugo-validator', 'tests')), 'a preview must not delete');
});
