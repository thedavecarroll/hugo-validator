// hugo-validator is distributed from GitHub only. The name "hugo-validator"
// on the npm registry is not ours, and `npx <name>` asks the registry whenever
// there is no local install. So nothing this package generates, prints or
// documents may use the package runner without `--no`, which makes it run the
// local copy or stop.
//
// The same goes for `npx playwright`: a registry copy would be a different
// version from the one the package installed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PRE_COMMIT_HOOK, LOCAL_BIN, hookUsesRegistryNpx } = require('../lib/hooks');
const { judgeHook } = require('../lib/doctor');

const ROOT = path.join(__dirname, '..');

/** Files whose text reaches users: shipped code, docs, workflows */
function scannedFiles() {
  const files = ['README.md', 'DOCUMENTATION.md', 'CHANGELOG.md'];
  for (const dir of ['bin', 'lib', 'docs', path.join('.github', 'workflows')]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (/\.(js|md|ya?ml)$/.test(name)) files.push(path.join(dir, name));
    }
  }
  return files;
}

// "npx <something>" where <something> is not the --no flag
const BARE_NPX = /\bnpx\s+(?!--no\b)[@a-z]/i;

/**
 * The parts of a line a reader could copy and run.
 * Code and YAML: the whole line. Markdown: fenced code lines and inline code
 * spans only, so prose such as "bare npx wording" is not mistaken for a command.
 */
function commandText(line, isMarkdown, inFence) {
  if (!isMarkdown || inFence) return line;
  return (line.match(/`[^`]+`/g) || []).join(' ');
}

test('no shipped code, doc or workflow tells anyone to run npx without --no', () => {
  const offenders = [];
  for (const file of scannedFiles()) {
    const isMarkdown = file.endsWith('.md');
    let inFence = false;
    fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
      if (isMarkdown && /^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      // Two sentences explain the unsafe form on purpose, and say so
      const explains = /plain `npx hugo-validator`|called `npx hugo-validator`/i.test(line);
      if (BARE_NPX.test(commandText(line, isMarkdown, inFence)) && !explains) {
        offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    `Use "npx --no <package>" (or an npm script). Bare npx can fetch from the npm registry:\n  ${offenders.join('\n  ')}`);
});

test('the generated pre-commit hook never uses the package runner', () => {
  const code = PRE_COMMIT_HOOK.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\bnpx\b/, 'the hook runs unattended: it must not be able to reach the registry');
  assert.ok(code.includes(`BIN="${LOCAL_BIN}"`));
  assert.match(code, /if \[ ! -x "\$BIN" \]/, 'a missing install must block the commit with a message');
  assert.match(code, /npm ci/);
  assert.match(code, /"\$BIN" validate --full/);
  assert.strictEqual(LOCAL_BIN, 'node_modules/.bin/hugo-validator');
});

test('hookUsesRegistryNpx recognises hooks from older versions', () => {
  assert.strictEqual(hookUsesRegistryNpx('#!/bin/sh\nnpx hugo-validator validate\n'), true);
  assert.strictEqual(hookUsesRegistryNpx('#!/bin/sh\nnpx hugo-validator validate --full\nexit $?\n'), true);
  assert.strictEqual(hookUsesRegistryNpx('#!/bin/sh\nnpx --no hugo-validator validate --full\n'), false);
  assert.strictEqual(hookUsesRegistryNpx(PRE_COMMIT_HOOK), false, 'comments in the new hook must not trigger it');
  assert.strictEqual(hookUsesRegistryNpx('#!/bin/sh\nnpm run validate:css\n'), false);
});

test('doctor: old npx hook warns, new hook is ok, foreign hook warns', () => {
  const old = judgeHook('#!/bin/sh\nnpx hugo-validator validate --full\n', '.githooks');
  assert.strictEqual(old.status, 'warn');
  assert.match(old.detail, /setup-hooks --force/);
  assert.match(old.detail, /registry/);

  assert.strictEqual(judgeHook(PRE_COMMIT_HOOK, '.githooks').status, 'ok');
  assert.strictEqual(judgeHook('#!/bin/sh\nnpm run lint\n', '.githooks').status, 'warn');
  assert.strictEqual(judgeHook('', '.githooks').status, 'warn');
});
