// "Will validation work on this machine, in this site?"
// Every check returns { name, status: 'ok' | 'warn' | 'fail', detail }.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, VALIDATOR_DIR, CONFIG_FILENAME } = require('./config');
const { findLegacy } = require('./migrate');
const { resolveBrowserExecutable, runtimePaths } = require('./runtime');
const { TOOLS, PACKAGE_ROOT, findPackage, toolEnv } = require('./tools');
const pkg = require('../package.json');

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail) => ({ name, status: 'warn', detail });
const fail = (name, detail) => ({ name, status: 'fail', detail });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { ok: !result.error && result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}`.trim(), missing: Boolean(result.error) };
}

/** [major, minor, patch] from the first x.y.z in a string */
function parseVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionAtLeast(version, minimum) {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/** Does an installed version satisfy a caret range such as ^11.16.0 ? */
function satisfiesCaret(installed, range) {
  const have = parseVersion(installed);
  const want = parseVersion(range);
  if (!have || !want) return true; // unknown format: do not block
  return have[0] === want[0] && versionAtLeast(have, want);
}

function checkNode() {
  const minimum = parseVersion(pkg.engines.node);
  const current = parseVersion(process.version);
  return versionAtLeast(current, minimum)
    ? ok('Node.js', process.version)
    : fail('Node.js', `${process.version} is older than the required ${pkg.engines.node}`);
}

function checkHugo() {
  const result = run('hugo', ['version']);
  if (result.missing) return fail('Hugo', 'not found on PATH');
  if (!/extended/.test(result.out)) return fail('Hugo', `not the extended build, which SCSS needs: ${result.out.slice(0, 60)}`);

  const minimum = pkg.hugoValidator.minHugoVersion;
  const installed = parseVersion(result.out);
  const label = installed ? `v${installed.join('.')} extended` : result.out.slice(0, 40);
  if (installed && !versionAtLeast(installed, parseVersion(minimum))) {
    return fail('Hugo', `${label} is older than the minimum ${minimum}`);
  }
  return ok('Hugo', label);
}

function checkSass(projectRoot) {
  const local = ['sass-embedded', 'sass'].find(name => fs.existsSync(path.join(projectRoot, 'node_modules', name)));
  if (local) return ok('Dart Sass', `${local} in node_modules`);
  const system = run('sass', ['--version']);
  if (system.ok) return ok('Dart Sass', `system sass ${system.out.split('\n')[0]}`);
  return warn('Dart Sass', 'not found. Needed only if the theme uses the dartsass transpiler: npm install sass-embedded');
}

function checkPortTool(hasCommand) {
  const tool = ['lsof', 'ss', 'fuser'].find(hasCommand);
  return tool
    ? ok('Port cleanup', `using ${tool}`)
    : warn('Port cleanup', 'none of lsof, ss, fuser found. Dev servers on the test port will not be stopped automatically');
}

/**
 * The package supplies the tools. Check that each one resolves, which copy of
 * Playwright will run, and whether the site still lists tools of its own.
 */
function checkTools(projectRoot) {
  const results = [];
  const missing = [];
  const versions = [];
  for (const name of TOOLS) {
    const found = findPackage(name, PACKAGE_ROOT);
    if (!found) missing.push(name);
    else versions.push(`${name} ${found.manifest.version}`);
  }
  results.push(missing.length === 0
    ? ok('Tools', versions.join(', '))
    : fail('Tools', `not installed: ${missing.join(', ')}. Reinstall hugo-validator: npm install`));

  // The synced tests import @playwright/test from inside the site. If the site
  // has its own copy, that copy runs. It must not be older than the package needs.
  const runtimeTests = runtimePaths(projectRoot).testsDir;
  const sitePlaywright = findPackage('@playwright/test', runtimeTests);
  const ownPlaywright = findPackage('@playwright/test', PACKAGE_ROOT);
  if (sitePlaywright && ownPlaywright && sitePlaywright.dir !== ownPlaywright.dir) {
    const range = pkg.dependencies['@playwright/test'];
    const detail = `the site's own @playwright/test ${sitePlaywright.manifest.version} will run the tests (the package ships ${ownPlaywright.manifest.version})`;
    results.push(satisfiesCaret(sitePlaywright.manifest.version, range)
      ? warn('Playwright copy', `${detail}. Remove it from the site's package.json to let hugo-validator manage the version`)
      : fail('Playwright copy', `${detail}, and it is older than the supported ${range}. Remove it from the site's package.json, then npm install`));
  }

  // A site no longer needs to list the tools. Listing them pins old versions.
  let siteManifest = {};
  try {
    siteManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {}
  const listed = TOOLS.filter(name => (siteManifest.devDependencies || {})[name] || (siteManifest.dependencies || {})[name]);
  if (listed.length > 0) {
    results.push(warn('Site package.json', `lists tools hugo-validator now supplies: ${listed.join(', ')}. They can be removed`));
  }
  return results;
}

function checkBrowser(projectRoot, config) {
  const executable = resolveBrowserExecutable(config);
  const script = `
    const { chromium } = require('@playwright/test');
    chromium.launch(${JSON.stringify(executable ? { executablePath: executable } : {})})
      .then(async b => { const v = b.version(); await b.close(); console.log(v); })
      .catch(e => { console.error(String(e.message).split('\\n')[0]); process.exit(1); });`;
  // Same resolution as a real run: the site's Playwright if it has one, else the package's
  const result = run(process.execPath, ['-e', script], { cwd: projectRoot, timeout: 60000, env: toolEnv() });
  const label = executable ? `Browser (${executable})` : 'Browser (Playwright Chromium)';
  if (result.ok) return ok(label, `headless launch works, Chromium ${result.out.split('\n').pop()}`);

  const firstLine = result.out.split('\n').find(line => line.trim()) || 'could not launch';
  let hint;
  if (executable) {
    hint = 'Check the browserExecutable path';
  } else if (/Executable doesn't exist|playwright install/i.test(result.out)) {
    // The browser build is tied to the Playwright version, so every Playwright update needs this
    hint = 'The browser for this Playwright version is not downloaded, which is normal after an update. Run: npx playwright install chromium';
  } else {
    hint = 'If system libraries are missing, install a system Chromium and set HUGO_VALIDATOR_BROWSER (see docs/ARCH-SETUP.md)';
  }
  return fail(label, `${firstLine.trim()}. ${hint}`);
}

function checkConfig(projectRoot, config) {
  const results = [];
  const configPath = path.join(projectRoot, VALIDATOR_DIR, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return [fail('Config', `${VALIDATOR_DIR}/${CONFIG_FILENAME} not found. Run: npx hugo-validator init`)];
  }
  results.push(/example\.com/.test(config.siteUrl)
    ? warn('Config siteUrl', 'still the example.com placeholder. Links to your own domain will be treated as external')
    : ok('Config siteUrl', config.siteUrl));

  const publicDir = path.join(projectRoot, 'public');
  if (fs.existsSync(publicDir)) {
    const missing = (config.responsive?.spotCheckPages || []).filter(page =>
      !fs.existsSync(path.join(publicDir, page, 'index.html')) && !fs.existsSync(path.join(publicDir, page)));
    results.push(missing.length === 0
      ? ok('Config spotCheckPages', 'all pages exist in public/')
      : warn('Config spotCheckPages', `not found in public/: ${missing.join(', ')}`));
  }
  return results;
}

function checkHook(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return warn('Git hook', 'not a git repository');
  const hooksPath = run('git', ['config', '--get', 'core.hooksPath'], { cwd: projectRoot }).out || '.git/hooks';
  let hook = '';
  try {
    hook = fs.readFileSync(path.join(projectRoot, hooksPath, 'pre-commit'), 'utf8');
  } catch {}
  if (!hook) return warn('Git hook', `no pre-commit hook in ${hooksPath}. Run: npx hugo-validator setup-hooks`);
  return /hugo-validator/.test(hook)
    ? ok('Git hook', `${hooksPath}/pre-commit runs hugo-validator`)
    : warn('Git hook', `${hooksPath}/pre-commit does not call hugo-validator. Run: npx hugo-validator migrate`);
}

function checkLegacy(projectRoot) {
  const legacy = findLegacy(projectRoot);
  return legacy.length === 0
    ? ok('Legacy files', 'none')
    : warn('Legacy files', `${legacy.map(item => item.path).join(', ')}. Run: npx hugo-validator migrate`);
}

async function doctor() {
  const projectRoot = process.cwd();
  const { hasCommand } = require('./validate');

  // loadConfig warns on its own when the file is missing: keep doctor's output clean
  const originalWarn = console.warn;
  console.warn = () => {};
  const config = loadConfig(projectRoot);
  console.warn = originalWarn;

  console.log(`hugo-validator ${pkg.version} doctor\n`);
  const results = [
    checkNode(),
    checkHugo(),
    checkSass(projectRoot),
    checkPortTool(hasCommand),
    ...checkTools(projectRoot),
    checkBrowser(projectRoot, config),
    ...checkConfig(projectRoot, config),
    checkHook(projectRoot),
    checkLegacy(projectRoot),
  ];

  const icons = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  for (const result of results) {
    console.log(`${icons[result.status]} ${result.name}: ${result.detail}`);
  }

  const failures = results.filter(result => result.status === 'fail').length;
  const warnings = results.filter(result => result.status === 'warn').length;
  console.log('');
  console.log(failures > 0
    ? `❌ ${failures} blocking problem(s), ${warnings} warning(s)`
    : `✅ Ready to validate${warnings ? ` (${warnings} warning(s))` : ''}`);
  return failures > 0 ? 1 : 0;
}

module.exports = { doctor, parseVersion, versionAtLeast, satisfiesCaret };
