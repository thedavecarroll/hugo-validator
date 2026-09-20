// Guards against silent version drift.
//
// The package promises a minimum Node version in package.json "engines". That
// promise is only true if every dependency supports that version too. This was
// wrong once (the package said Node 18 while html-validate needed 22), and it
// was only noticed by hand. When a dependency update raises its Node floor,
// this test fails and names the dependency, so "engines", the README and CI
// can be raised together.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const semver = require('semver');

const pkg = require('../package.json');
const { findPackage, PACKAGE_ROOT, TOOLS } = require('../lib/tools');

const minimumNode = semver.minVersion(pkg.engines.node);

test('engines.node is a single lower bound', () => {
  assert.match(pkg.engines.node, /^>=\d+\.\d+\.\d+$/, 'keep engines.node in the simple ">=x.y.z" form');
});

test('every dependency supports the minimum Node version the package promises', () => {
  const unsupported = [];
  for (const name of Object.keys(pkg.dependencies)) {
    const found = findPackage(name, PACKAGE_ROOT);
    assert.ok(found, `${name} is not installed - run npm install`);
    const range = found.manifest.engines && found.manifest.engines.node;
    if (range && !semver.satisfies(minimumNode, range)) {
      unsupported.push(`${name}@${found.manifest.version} needs Node ${range}`);
    }
  }
  assert.deepStrictEqual(unsupported, [],
    `package.json promises Node ${pkg.engines.node} (minimum ${minimumNode}), but:\n  ${unsupported.join('\n  ')}\n` +
    'Raise engines.node, the README requirements table, docs/ARCH-SETUP.md and the CI matrix together.');
});

test('the Node version running these tests is supported', () => {
  assert.ok(semver.satisfies(process.version, pkg.engines.node),
    `tests are running on Node ${process.version}, outside the supported ${pkg.engines.node}`);
});

test('@types/node describes the oldest supported Node, not a newer one', () => {
  // Newer types make the type check accept APIs that do not exist on the
  // supported minimum. Nothing else can catch that: type definitions never
  // run, so CI stays green on such a bump.
  const supportedMajor = minimumNode.major;
  const fix = `Either revert the @types/node bump, or raise the supported Node on purpose: engines.node in package.json, ` +
    'the README requirements table, docs/ARCH-SETUP.md and the CI matrix, all together.';

  const installed = findPackage('@types/node', PACKAGE_ROOT);
  assert.ok(installed, '@types/node is not installed - run npm install');
  assert.strictEqual(semver.major(installed.manifest.version), supportedMajor,
    `@types/node ${installed.manifest.version} is installed, but the package supports Node ${pkg.engines.node}. ${fix}`);

  const range = pkg.devDependencies['@types/node'];
  assert.match(range, /^\^\d+\.\d+\.\d+$/, 'keep the @types/node range in the caret form, e.g. ^24.0.0');
  assert.strictEqual(semver.minVersion(range).major, supportedMajor,
    `devDependencies lists @types/node ${range}, but the package supports Node ${pkg.engines.node}. ${fix}`);
});

test('the tools are real dependencies, not peers', () => {
  for (const name of TOOLS) {
    assert.ok(pkg.dependencies[name], `${name} must be in dependencies so sites do not have to list it`);
  }
  assert.strictEqual(pkg.peerDependencies, undefined, 'peer dependencies would push version management back onto every site');
});

test('docs state the same Node minimum as package.json', () => {
  const minimum = minimumNode.version;
  for (const file of ['README.md', path.join('docs', 'ARCH-SETUP.md')]) {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
    assert.ok(text.includes(minimum), `${file} does not mention Node ${minimum}`);
  }
});

test('minHugoVersion is a valid version', () => {
  assert.ok(semver.valid(pkg.hugoValidator.minHugoVersion));
});
