const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  globToRegex, globBase, walkFiles, computeDigest, planStage, statusToCache,
  isPreCommitHook, listHtmlFiles,
} = require('../lib/validate');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-'));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('globToRegex handles **, * and literal dots', () => {
  const scss = globToRegex('themes/*/assets/scss/**/*.scss');
  assert.ok(scss.test('themes/techjournal/assets/scss/main.scss'));
  assert.ok(scss.test('themes/techjournal/assets/scss/a/b/_c.scss'));
  assert.ok(!scss.test('themes/a/b/assets/scss/main.scss'));
  assert.ok(!scss.test('themes/techjournal/assets/scss/mainXscss'));

  const pagination = globToRegex('**/page/*/index.html');
  assert.ok(pagination.test('public/tags/x/page/2/index.html'));
  assert.ok(pagination.test('page/2/index.html'));
  assert.ok(!pagination.test('public/page/index.html'));
});

test('globBase returns the leading non-glob directory', () => {
  assert.strictEqual(globBase('themes/*/assets/scss/**/*.scss'), 'themes');
  assert.strictEqual(globBase('assets/scss/**/*.scss'), 'assets/scss');
  assert.strictEqual(globBase('**/*.css'), '.');
  assert.strictEqual(globBase('assets/main.css'), 'assets/main.css');
});

test('walkFiles has no file cap and skips node_modules', () => {
  const files = { 'node_modules/x/index.js': 'x' };
  for (let i = 0; i < 650; i++) files[`content/post-${i}.md`] = `post ${i}`;
  const root = makeTree(files);
  assert.strictEqual(walkFiles('content', root).length, 650);
  assert.deepStrictEqual(walkFiles('.', root).filter(f => f.includes('node_modules')), []);
  assert.deepStrictEqual(walkFiles('missing', root), []);
});

test('digest changes on edit, add and delete, including the 150th file', () => {
  const files = { 'layouts/index.html': '<html>' };
  for (let i = 0; i < 200; i++) files[`content/post-${String(i).padStart(3, '0')}.md`] = `post ${i}`;
  const root = makeTree(files);
  const inputs = [{ path: 'content' }, { path: 'layouts' }];

  const base = computeDigest(inputs, root);
  assert.strictEqual(computeDigest(inputs, root), base, 'digest is stable');

  // Old code only hashed the first 100 files: file 150 and layouts were invisible
  fs.writeFileSync(path.join(root, 'content/post-150.md'), 'edited');
  const afterEdit = computeDigest(inputs, root);
  assert.notStrictEqual(afterEdit, base);

  fs.writeFileSync(path.join(root, 'layouts/index.html'), '<html lang="en">');
  const afterLayout = computeDigest(inputs, root);
  assert.notStrictEqual(afterLayout, afterEdit);

  fs.writeFileSync(path.join(root, 'content/new.md'), 'new');
  const afterAdd = computeDigest(inputs, root);
  assert.notStrictEqual(afterAdd, afterLayout);

  fs.unlinkSync(path.join(root, 'content/new.md'));
  assert.strictEqual(computeDigest(inputs, root), afterLayout, 'delete restores the earlier digest');
});

test('digest honours the match filter', () => {
  const root = makeTree({ 'public/index.html': 'a', 'public/app.js': 'b' });
  const inputs = [{ path: 'public', match: '**/*.html' }];
  const base = computeDigest(inputs, root);
  fs.writeFileSync(path.join(root, 'public/app.js'), 'changed');
  assert.strictEqual(computeDigest(inputs, root), base);
  fs.writeFileSync(path.join(root, 'public/index.html'), 'changed');
  assert.notStrictEqual(computeDigest(inputs, root), base);
});

test('planStage: skip only when passed and unchanged', () => {
  const plan = (o) => planStage({ stage: 'html', forceAll: false, digest: 'd1', ...o });
  assert.deepStrictEqual(plan({ previousStatus: 'passed', previousDigest: 'd1' }).run, false);
  assert.strictEqual(plan({ previousStatus: 'passed', previousDigest: 'd0' }).run, true);
  assert.strictEqual(plan({ previousStatus: 'failed', previousDigest: 'd1' }).run, true);
  assert.strictEqual(plan({ previousStatus: undefined, previousDigest: undefined }).run, true);
  assert.strictEqual(plan({ previousStatus: 'passed', previousDigest: 'd1', forceAll: true }).run, true);
});

test('--last-failed state machine: failed -> partial -> full run -> passed', () => {
  const plan = (o) => planStage({ stage: 'tests', forceAll: false, digest: 'd1', ...o });

  // Failed and inputs changed: a full run, never --last-failed
  let p = plan({ previousStatus: 'failed', previousDigest: 'd0' });
  assert.deepStrictEqual([p.run, p.lastFailed], [true, false]);

  // Failed and inputs identical: --last-failed is allowed
  p = plan({ previousStatus: 'failed', previousDigest: 'd1' });
  assert.deepStrictEqual([p.run, p.lastFailed], [true, true]);

  // A passing --last-failed run is only 'partial'
  assert.strictEqual(statusToCache('passed', true), 'partial');
  assert.strictEqual(statusToCache('failed', true), 'failed');
  assert.strictEqual(statusToCache('passed', false), 'passed');

  // 'partial' is never skipped and never uses --last-failed: it forces a full run
  p = plan({ previousStatus: 'partial', previousDigest: 'd1' });
  assert.deepStrictEqual([p.run, p.lastFailed], [true, false]);

  // Other stages never get --last-failed
  assert.strictEqual(planStage({ stage: 'css', forceAll: false, previousStatus: 'failed', previousDigest: 'd1', digest: 'd1' }).lastFailed, false);
});

test('isPreCommitHook detects git hook context', () => {
  assert.strictEqual(isPreCommitHook({}), false);
  assert.strictEqual(isPreCommitHook({ GIT_INDEX_FILE: '.git/index' }), true);
  assert.strictEqual(isPreCommitHook({ PRE_COMMIT: '1' }), true);
});

test('listHtmlFiles applies excludes and keeps paths with spaces', () => {
  const root = makeTree({
    'public/index.html': '',
    'public/my post/index.html': '',
    'public/tags/x/page/2/index.html': '',
    'public/app.js': '',
  });
  const files = listHtmlFiles({ htmlValidation: { exclude: ['**/page/*/index.html'] } }, root);
  assert.deepStrictEqual(files, ['public/index.html', 'public/my post/index.html']);
});

test('formatDuration', () => {
  const { formatDuration } = require('../lib/validate');
  assert.strictEqual(formatDuration(42), '42s');
  assert.strictEqual(formatDuration(174), '2m 54s');
});
