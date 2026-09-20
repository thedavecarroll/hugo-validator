// Locate the tools this package depends on and launch them directly with
// Node. Nothing goes through npx, so a run never depends on how npm laid out
// a site's node_modules and can never fetch a package from the registry.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const PACKAGE_ROOT = path.join(__dirname, '..');
const PACKAGE_NODE_MODULES = path.join(PACKAGE_ROOT, 'node_modules');

/** Tools the package supplies to a site */
const TOOLS = [
  '@playwright/test',
  '@axe-core/playwright',
  'html-validate',
  'stylelint',
  'stylelint-config-standard-scss',
];

/**
 * Find an installed package by walking node_modules folders upwards from
 * fromDir. Reads package.json from disk, because packages with an "exports"
 * map refuse require('<name>/package.json').
 * Returns { dir, manifest } or null.
 */
function findPackage(name, fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'noop.js'));
  for (const modulesDir of requireFrom.resolve.paths(name) || []) {
    const dir = path.join(modulesDir, name);
    const manifestPath = path.join(dir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        // realpath: a linked checkout and a plain path must compare equal
        return { dir: fs.realpathSync(dir), manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Absolute path of a package's executable, searched from each dir in turn.
 * Returns { bin, version, dir }. Throws when the package is not installed.
 */
function resolveBin(name, binName, fromDirs = [PACKAGE_ROOT]) {
  for (const fromDir of fromDirs) {
    const found = findPackage(name, fromDir);
    if (!found) continue;

    const { bin } = found.manifest;
    const relative = typeof bin === 'string' ? bin : bin && bin[binName];
    if (!relative) throw new Error(`${name} ${found.manifest.version} has no "${binName}" executable`);
    return { bin: path.join(found.dir, relative), version: found.manifest.version, dir: found.dir };
  }
  throw new Error(`${name} is not installed. Reinstall hugo-validator: npm install`);
}

/**
 * Playwright must be ONE copy: the runner and the synced tests have to load
 * the same @playwright/test or Playwright refuses to run.
 *
 * The tests live in <site>/hugo-validator/.runtime/tests and resolve from
 * there. So look from there first: if the site has a copy (the normal,
 * hoisted install), run that copy. Otherwise run the package's own copy,
 * which the tests then find through NODE_PATH (see toolEnv).
 */
function resolvePlaywright(runtimeTestsDir) {
  const resolved = resolveBin('@playwright/test', 'playwright', [runtimeTestsDir, PACKAGE_ROOT]);
  const own = findPackage('@playwright/test', PACKAGE_ROOT);
  return { ...resolved, fromSite: !own || own.dir !== resolved.dir };
}

/**
 * Environment for a launched tool. NODE_PATH lets the synced tests fall back
 * to this package's dependencies when the site has none of its own.
 */
function toolEnv(env = process.env, extra = {}) {
  const nodePath = [PACKAGE_NODE_MODULES, env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return { ...env, ...extra, NODE_PATH: nodePath };
}

module.exports = {
  TOOLS,
  PACKAGE_ROOT,
  PACKAGE_NODE_MODULES,
  findPackage,
  resolveBin,
  resolvePlaywright,
  toolEnv,
};
