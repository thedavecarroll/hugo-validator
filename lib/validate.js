const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { prepareRuntime, PACKAGE_TESTS_DIR } = require('./runtime');
const { version: PACKAGE_VERSION } = require('../package.json');

const CACHE_FILE = 'hugo-validator/.validation-cache.json';
const CACHE_VERSION = 2;
const VALID_STAGES = ['hugo', 'css', 'html', 'tests'];
const IGNORED_DIRS = new Set(['node_modules', '.git']);

function emptyCache() {
  return { version: CACHE_VERSION, tests: {}, stageDigests: {}, durations: {}, lastRun: null };
}

/**
 * Load validation cache. Caches from older versions are discarded.
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cache && cache.version === CACHE_VERSION) {
        return { ...emptyCache(), ...cache };
      }
    }
  } catch {}
  return emptyCache();
}

/**
 * Save validation cache
 */
function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('Warning: Could not save cache:', e.message);
  }
}

/**
 * Convert a glob (supports **, * and ?) to a RegExp matched against
 * forward-slash relative paths.
 */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * The non-glob leading directory of a pattern ('themes/x/**' -> 'themes')
 */
function globBase(pattern) {
  const segments = pattern.split('/');
  const base = [];
  for (const segment of segments) {
    if (/[*?[\]{}]/.test(segment)) break;
    base.push(segment);
  }
  if (base.length === segments.length) return pattern; // no glob: a plain path
  return base.join('/') || '.';
}

/**
 * List every file under a path (or the path itself if it is a file).
 * Returns sorted, forward-slash paths relative to root. No caps.
 */
function walkFiles(target, root = process.cwd()) {
  const absolute = path.resolve(root, target);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return [];
  }

  const toRelative = (file) => {
    // Files of this package get a location-independent name, so a symlinked
    // checkout and a real install produce the same digest
    if (file.startsWith(PACKAGE_TESTS_DIR + path.sep)) {
      return `<hugo-validator>/tests/${path.relative(PACKAGE_TESTS_DIR, file).split(path.sep).join('/')}`;
    }
    return path.relative(root, file).split(path.sep).join('/');
  };
  if (stat.isFile()) return [toRelative(absolute)];
  if (!stat.isDirectory()) return [];

  const files = [];
  const stack = [absolute];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(toRelative(entryPath));
      }
    }
  }
  return files.sort();
}

/**
 * Inputs that decide whether a stage needs to run again.
 * Each input is { path, match? } where match is an optional glob filter.
 */
function getStageInputs(config) {
  const validatorConfig = 'hugo-validator/hugo-validator.config.js';
  return {
    hugo: [
      'hugo.yaml', 'hugo.toml', 'hugo.json', 'config.yaml', 'config.toml', 'config.json',
      'config', 'content', 'layouts', 'themes', 'data', 'assets', 'static', 'i18n', 'archetypes',
      validatorConfig,
    ].map(p => ({ path: p })),
    css: [
      { path: globBase(config.cssPattern), match: config.cssPattern },
      { path: 'hugo-validator/.stylelintrc.json' },
    ],
    html: [
      { path: 'public', match: '**/*.html' },
      { path: 'hugo-validator/.htmlvalidate.json' },
      { path: validatorConfig },
    ],
    tests: [
      { path: 'public' },
      { path: PACKAGE_TESTS_DIR }, // the tests live in the package, not in the site
      { path: validatorConfig },
    ],
  };
}

/**
 * One digest over every input file of a stage (path + content).
 * Any edit, addition or deletion changes the digest.
 */
function computeDigest(inputs, root = process.cwd(), salt = '') {
  const seen = new Set();
  for (const input of inputs) {
    const matcher = input.match ? globToRegex(input.match) : null;
    for (const file of walkFiles(input.path, root)) {
      if (!matcher || matcher.test(file)) seen.add(file);
    }
  }

  const digest = crypto.createHash('sha256');
  digest.update(`salt\0${salt}\n`);
  for (const file of [...seen].sort()) {
    let contentHash = 'unreadable';
    try {
      contentHash = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root, file))).digest('hex');
    } catch {}
    digest.update(`${file}\0${contentHash}\n`);
  }
  return digest.digest('hex');
}

/**
 * Decide whether a stage runs, and whether Playwright may use --last-failed.
 *
 * --last-failed is only safe when the inputs are identical to the failing run.
 * A passing --last-failed run is recorded as 'partial', which forces one full
 * run before the stage can ever be skipped.
 */
function planStage({ stage, forceAll, previousStatus, previousDigest, digest }) {
  if (forceAll) return { run: true, lastFailed: false };
  const unchanged = previousDigest !== undefined && previousDigest === digest;
  if (previousStatus === 'passed' && unchanged) {
    return { run: false, lastFailed: false, skipReason: 'unchanged' };
  }
  return { run: true, lastFailed: stage === 'tests' && previousStatus === 'failed' && unchanged };
}

/**
 * Status to store in the cache after a stage ran
 */
function statusToCache(status, lastFailed) {
  return status === 'passed' && lastFailed ? 'partial' : status;
}

/**
 * Detect if running in pre-commit hook context.
 * Git sets GIT_INDEX_FILE for hooks, which covers hooks generated before
 * the hook itself passed --full.
 */
function isPreCommitHook(env = process.env) {
  return env.HUSKY_GIT_PARAMS !== undefined ||
         env.PRE_COMMIT === '1' ||
         env.GIT_HOOK === '1' ||
         env.GIT_INDEX_FILE !== undefined;
}

/**
 * Run the validation pipeline
 * @param {object} options - CLI options
 * @returns {number} Exit code (0 = success, 1 = failure)
 */
async function validate(options = {}) {
  const stages = options.only ? [options.only] : VALID_STAGES;
  for (const stage of stages) {
    if (!VALID_STAGES.includes(stage)) {
      console.error(`Unknown stage: ${stage}`);
      console.error(`Valid stages: ${VALID_STAGES.join(', ')}`);
      return 1;
    }
  }

  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19).replace('T', '_');
  const reportDir = path.join(config.reportsDir, timestamp);

  // Determine mode: smart mode is the default, hooks and --full run everything
  const forceAll = Boolean(options.full || options.force || isPreCommitHook());

  // Reports need both the CLI option and the config setting
  const saveLogs = options.report !== false && config.generateReport !== false;

  const cache = loadCache();

  // Kill dev servers unless --no-kill
  if (options.kill !== false) {
    await killPorts(config.portsToKill);
  }

  console.log(forceAll ? 'Running validators...\n' : 'Running validators (smart mode - skipping unchanged)...\n');

  if (saveLogs) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  let failed = false;
  let anyStageRan = false;
  let hugoFailed = false;
  const results = {
    hugo: { status: 'skipped', log: '' },
    css: { status: 'skipped', log: '' },
    html: { status: 'skipped', log: '' },
    tests: { status: 'skipped', log: '' },
  };
  const stageInputs = getStageInputs(config);

  for (const stage of stages) {
    // html and tests read public/, which is stale if the build failed
    if (hugoFailed && (stage === 'html' || stage === 'tests')) {
      console.log(`⏭️  ${stage} (skipped - hugo build failed)`);
      results[stage] = { status: 'skipped', log: 'Skipped: hugo build failed' };
      continue;
    }

    // Digest is taken before the stage runs. For html and tests that is
    // after the hugo stage, so it reflects the freshly built public/.
    // The package version is part of every digest: upgrading re-runs everything once
    const digest = computeDigest(stageInputs[stage], process.cwd(), PACKAGE_VERSION);
    const plan = planStage({
      stage,
      forceAll,
      previousStatus: cache.tests[stage],
      previousDigest: cache.stageDigests[stage],
      digest,
    });

    if (!plan.run) {
      console.log(`⏭️  ${stage} (skipped - ${plan.skipReason})`);
      results[stage] = { status: 'skipped', log: `Skipped: ${plan.skipReason}` };
      continue;
    }

    anyStageRan = true;

    // Tell the user how long to expect, based on the last complete run of this stage
    const lastDuration = cache.durations[stage];
    if (lastDuration >= 5 && !plan.lastFailed) {
      console.log(`⏳ ${stage}: last run took ${formatDuration(lastDuration)}`);
    }
    const stageStart = Date.now();

    switch (stage) {
      case 'hugo':
        results.hugo = await runHugoBuild(reportDir, saveLogs);
        break;
      case 'css':
        results.css = await runCssValidation(config, reportDir, saveLogs);
        break;
      case 'html':
        results.html = await runHtmlValidation(config, reportDir, saveLogs);
        break;
      case 'tests':
        results.tests = await runPlaywrightTests(config, reportDir, saveLogs, plan.lastFailed, options.verbose);
        break;
    }

    // Always store the digest, also under --full, so smart mode has a baseline
    cache.tests[stage] = statusToCache(results[stage].status, plan.lastFailed);
    cache.stageDigests[stage] = digest;
    if (!plan.lastFailed) {
      cache.durations[stage] = Math.round((Date.now() - stageStart) / 1000);
    }

    if (results[stage].status === 'failed') {
      failed = true;
      if (stage === 'hugo') hugoFailed = true;
    }
  }

  // Save cache after run
  cache.lastRun = new Date().toISOString();
  saveCache(cache);

  if (saveLogs) {
    generateReport(config, results, reportDir, timestamp);
    cleanupOldReports(config);
  }

  console.log('');

  if (!failed && !anyStageRan) {
    console.log(`✅ All stages previously passed (no changes detected)`);
    console.log(`   Run with --full to force all stages`);
    return 0;
  }

  if (failed) {
    console.log(`❌ Validation failed`);
    if (saveLogs) {
      console.log(`   See: ${config.reportFilename}`);
    }
    return 1;
  }

  console.log(`✅ All validations passed`);
  if (saveLogs) {
    console.log(`   Report: ${config.reportFilename}`);
  }
  return 0;
}

/**
 * 75 -> '1m 15s', 42 -> '42s'
 */
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/**
 * Clear the validation cache
 */
function clearCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
      console.log('✅ Validation cache cleared');
    } else {
      console.log('No cache to clear');
    }
  } catch (e) {
    console.error('Error clearing cache:', e.message);
  }
}

function hasCommand(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

/**
 * PIDs from `ss -ltnpH` output, e.g. users:(("hugo",pid=1234,fd=3))
 */
function parseSsPids(output) {
  return [...new Set([...String(output).matchAll(/pid=(\d+)/g)].map(match => parseInt(match[1], 10)))];
}

function parsePidList(output) {
  return [...new Set(String(output).split(/\s+/).map(token => parseInt(token, 10)).filter(pid => pid > 0))];
}

/**
 * PIDs LISTENING on a TCP port. Uses whichever tool the machine has:
 * lsof (macOS, most Linux), else ss or fuser (minimal Linux installs).
 * Returns null when no tool is available.
 */
function findListeners(portNum, available = hasCommand) {
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.error ? '' : (result.stdout || '');
  };

  // -sTCP:LISTEN matters: without it lsof also returns clients, such as a
  // browser tab connected to the port
  if (available('lsof')) return parsePidList(run('lsof', ['-ti', `tcp:${portNum}`, '-sTCP:LISTEN']));
  if (available('ss')) return parseSsPids(run('ss', ['-ltnpH', `sport = :${portNum}`]));
  if (available('fuser')) return parsePidList(run('fuser', ['-n', 'tcp', String(portNum)]).replace(/^.*:/, ''));
  return null;
}

/**
 * Kill processes LISTENING on the specified ports.
 */
async function killPorts(ports) {
  let killedAny = false;
  let warned = false;

  for (const port of ports || []) {
    // Validate port is a number to prevent command injection
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) continue;

    const pids = findListeners(portNum);
    if (pids === null) {
      if (!warned) console.warn('Warning: none of lsof, ss or fuser found - cannot free ports before validation');
      warned = true;
      continue;
    }

    for (const pid of pids.filter(pid => pid !== process.pid)) {
      try {
        process.kill(pid);
        killedAny = true;
        console.log(`Stopped process ${pid} listening on port ${portNum}`);
      } catch {
        // Process already gone or not ours to kill
      }
    }
  }

  // Give processes time to exit
  if (killedAny) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Write a stage log if logs are enabled, and tell the user where it is
 */
function writeStageLog(reportDir, saveLog, filename, content, announce) {
  if (!saveLog) return;
  fs.writeFileSync(path.join(reportDir, filename), content);
  if (announce) console.log(`   See: ${path.join(reportDir, filename)}`);
}

/**
 * Run Hugo build
 */
async function runHugoBuild(reportDir, saveLog) {
  // --cleanDestinationDir removes pages deleted from content, so they are
  // not validated forever from a stale public/
  const result = spawnSync('hugo', ['--panicOnWarning', '--cleanDestinationDir'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = result.error
    ? `Could not run hugo: ${result.error.message}`
    : `${result.stdout || ''}${result.stderr || ''}`;

  if (!result.error && result.status === 0) {
    console.log('✅ Hugo build');
    writeStageLog(reportDir, saveLog, 'hugo-build.log', output, false);
    return { status: 'passed', log: output };
  }

  console.log('❌ Hugo build failed (or has warnings)');
  writeStageLog(reportDir, saveLog, 'hugo-build.log', output, true);
  console.log(output);
  return { status: 'failed', log: output };
}

/**
 * Run CSS validation with stylelint
 */
async function runCssValidation(config, reportDir, saveLog) {
  const matcher = globToRegex(config.cssPattern);
  const cssFiles = walkFiles(globBase(config.cssPattern)).filter(file => matcher.test(file));

  if (cssFiles.length === 0) {
    const message = `No files match cssPattern '${config.cssPattern}' - nothing to validate`;
    console.log(`✅ CSS validation (⚠️  ${message})`);
    writeStageLog(reportDir, saveLog, 'css-validation.log', message, false);
    return { status: 'passed', log: message };
  }

  const result = spawnSync(
    'npx',
    ['stylelint', '--config', 'hugo-validator/.stylelintrc.json', '--formatter', 'verbose', '--allow-empty-input', config.cssPattern],
    { encoding: 'utf8' }
  );
  const output = result.error
    ? `Could not run stylelint: ${result.error.message}`
    : `${result.stdout || ''}${result.stderr || ''}`;

  if (!result.error && result.status === 0) {
    console.log('✅ CSS validation');
    writeStageLog(reportDir, saveLog, 'css-validation.log', output, false);
    return { status: 'passed', log: output };
  }

  console.log('❌ CSS validation failed');
  writeStageLog(reportDir, saveLog, 'css-validation.log', output, true);
  console.log(output);
  return { status: 'failed', log: output };
}

/**
 * HTML files in public/, minus the configured exclude globs
 */
function listHtmlFiles(config, root = process.cwd()) {
  const excludes = (config.htmlValidation?.exclude || []).map(globToRegex);
  return walkFiles('public', root)
    .filter(file => file.endsWith('.html'))
    .filter(file => !excludes.some(exclude => exclude.test(file)));
}

/**
 * Run HTML validation
 */
async function runHtmlValidation(config, reportDir, saveLog) {
  const files = listHtmlFiles(config);

  if (files.length === 0) {
    const message = 'No HTML files found in public/ - nothing to validate';
    console.log(`✅ HTML validation (⚠️  ${message})`);
    writeStageLog(reportDir, saveLog, 'html-validation.log', message, false);
    return { status: 'passed', log: message };
  }

  // Files are passed as arguments (no shell), in chunks to stay under the
  // OS argument length limit. Paths with spaces are safe.
  const CHUNK_SIZE = 200;
  let output = '';
  let ok = true;

  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const result = spawnSync(
      'npx',
      ['html-validate', '--config', 'hugo-validator/.htmlvalidate.json', '--formatter', 'stylish', ...chunk],
      { encoding: 'utf8' }
    );
    if (result.error) {
      output += `Could not run html-validate: ${result.error.message}\n`;
      ok = false;
      break;
    }
    output += `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0) ok = false;
  }

  if (ok) {
    console.log('✅ HTML validation');
    const logContent = `Validating ${files.length} HTML files...\n${output}\n${files.length} files validated, 0 errors`;
    writeStageLog(reportDir, saveLog, 'html-validation.log', logContent, false);
    return { status: 'passed', log: logContent };
  }

  console.log('❌ HTML validation failed');
  writeStageLog(reportDir, saveLog, 'html-validation.log', output, true);
  console.log(output);
  return { status: 'failed', log: output };
}

/**
 * Run Playwright tests
 * @param {boolean} lastFailedOnly - If true, only run previously failed tests
 */
async function runPlaywrightTests(config, reportDir, saveLog, lastFailedOnly = false, verbose = false) {
  return new Promise((resolve) => {
    // Tests and config are synced from the package into a gitignored folder
    const runtime = prepareRuntime(config);
    const args = ['playwright', 'test', '--config', runtime.configArg];

    // The tests mostly wait on page loads, so more workers than Playwright's
    // default (half the cores) finishes sooner. CI keeps the config's setting.
    if (!process.env.CI && config.testWorkers) {
      args.push(`--workers=${config.testWorkers}`);
    }

    if (lastFailedOnly) {
      args.push('--last-failed');
      console.log('Running Playwright tests (previously failed tests only, inputs unchanged)...');
    } else {
      console.log('Running Playwright tests...');
    }

    // Remove results from an earlier run so a crashed run cannot show them
    const resultsPath = runtime.resultsPath;
    try {
      fs.rmSync(resultsPath, { force: true });
    } catch {}

    const playwright = spawn('npx', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HUGO_VALIDATOR_VERBOSE: verbose ? '1' : '0' },
    });

    let output = '';

    playwright.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    playwright.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    playwright.on('error', (error) => {
      output += `Could not run playwright: ${error.message}\n`;
      console.log('❌ Playwright tests failed');
      console.log(output);
      writeStageLog(reportDir, saveLog, 'playwright.log', output, true);
      resolve({ status: 'failed', log: output });
    });

    playwright.on('close', (code) => {
      // Display formatted results from results.json
      if (fs.existsSync(resultsPath)) {
        try {
          const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
          console.log('');

          for (const suite of results.suites) {
            const failed = suite.tests.filter(test => test.status === 'failed').length;
            const skipped = suite.tests.filter(test => test.status === 'skipped').length;
            const passed = suite.tests.filter(test => test.status === 'passed').length;
            const warned = suite.tests.some(test => (test.warnings || []).length > 0);
            const icon = failed > 0 ? '❌' : passed === 0 && skipped > 0 ? '⏭️' : warned ? '⚠️ ' : '✅';
            const status = failed > 0 ? 'failed' : passed === 0 && skipped > 0 ? 'skipped' : 'passed';
            console.log(`${icon} ${suite.suite}: ${status}${warned && failed === 0 ? ' with warnings' : ''} (${passed} passed, ${failed} failed, ${skipped} skipped)`);

            for (const test of suite.tests.filter(test => (test.errors || []).length > 0)) {
              for (const err of test.errors) {
                console.log(`   ❗ ${test.name}: ${err}`);
              }
            }
            for (const test of suite.tests.filter(test => (test.warnings || []).length > 0)) {
              for (const warning of test.warnings) {
                console.log(`   ⚠️  ${test.name} (warning, does not fail validation): ${warning}`);
              }
            }
          }

          console.log(`\n📊 Summary: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped (${results.duration})`);
          console.log('');

          if (!output.trim()) {
            output = JSON.stringify(results, null, 2);
          }

          // Copy results to report dir
          if (saveLog) {
            fs.copyFileSync(resultsPath, path.join(reportDir, 'playwright-results.json'));
          }
        } catch (e) {
          // Couldn't parse results, just show raw output
          console.log(output);
        }
      } else {
        console.log(output);
      }

      if (code !== 0) {
        console.log('❌ Playwright tests failed');
        writeStageLog(reportDir, saveLog, 'playwright.log', output, true);
        resolve({ status: 'failed', log: output });
      } else {
        console.log('✅ Playwright tests');
        writeStageLog(reportDir, saveLog, 'playwright.log', output, false);
        resolve({ status: 'passed', log: output });
      }
    });
  });
}

/**
 * Run Playwright directly (npm test, npm run test:links, --ui).
 * Output goes straight to the terminal. Returns Playwright's exit code.
 */
async function runTests(filters = [], options = {}) {
  const config = loadConfig();
  const runtime = prepareRuntime(config);
  const args = ['playwright', 'test', '--config', runtime.configArg, ...filters];
  if (options.ui) args.push('--ui');
  if (!process.env.CI && config.testWorkers && !options.ui) args.push(`--workers=${config.testWorkers}`);

  return new Promise((resolve) => {
    const child = spawn('npx', args, { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`Could not run playwright: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

/**
 * Generate combined validation report
 */
function generateReport(config, results, reportDir, timestamp) {
  const hugoStatus = results.hugo.status === 'passed' ? 'PASSED' : results.hugo.status === 'failed' ? 'FAILED' : 'SKIPPED';
  const cssStatus = results.css.status === 'passed' ? 'PASSED' : results.css.status === 'failed' ? 'FAILED' : 'SKIPPED';
  const htmlStatus = results.html.status === 'passed' ? 'PASSED' : results.html.status === 'failed' ? 'FAILED' : 'SKIPPED';
  const testStatus = results.tests.status === 'passed' ? 'PASSED' : results.tests.status === 'failed' ? 'FAILED' : 'SKIPPED';

  let report = `# Validation Report

Generated: ${new Date().toLocaleString()}

---

## Hugo Build: ${hugoStatus === 'PASSED' ? '✅ PASSED' : hugoStatus === 'FAILED' ? '❌ FAILED' : '⏭️ SKIPPED'}

\`\`\`
${results.hugo.log.trim() || 'Not run'}
\`\`\`

---

## CSS Validation: ${cssStatus === 'PASSED' ? '✅ PASSED' : cssStatus === 'FAILED' ? '❌ FAILED' : '⏭️ SKIPPED'}

\`\`\`
${results.css.log.trim() || (cssStatus === 'PASSED' ? 'CSS validation completed successfully.' : 'Not run')}
\`\`\`

---

## HTML Validation: ${htmlStatus === 'PASSED' ? '✅ PASSED' : htmlStatus === 'FAILED' ? '❌ FAILED' : '⏭️ SKIPPED'}

\`\`\`
${results.html.log.trim() || 'Not run'}
\`\`\`

---

## Playwright Tests: ${testStatus === 'PASSED' ? '✅ PASSED' : testStatus === 'FAILED' ? '❌ FAILED' : '⏭️ SKIPPED'}

`;

  // Add Playwright results if available
  const resultsPath = path.join(reportDir, 'playwright-results.json');
  if (fs.existsSync(resultsPath)) {
    try {
      const testResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

      for (const suite of testResults.suites) {
        report += `### ${suite.suite}\n\n`;
        report += `| Test | Status | Duration |\n`;
        report += `|------|--------|----------|\n`;

        for (const test of suite.tests) {
          const hasWarnings = test.warnings && test.warnings.length > 0;
          const icon = test.status === 'failed' ? '❌' : test.status !== 'passed' ? '⏭️' : hasWarnings ? '⚠️' : '✅';
          report += `| ${test.name} | ${icon} | ${test.duration} |\n`;
        }
        report += `\n`;

        // Add warnings (reported, but they do not fail validation)
        for (const test of suite.tests) {
          if (test.warnings && test.warnings.length > 0) {
            report += `**${test.name}** - ⚠️ Warnings (do not fail validation):\n\n`;
            for (const warning of test.warnings) {
              report += `\`\`\`\n${warning}\n\`\`\`\n`;
            }
            report += `\n`;
          }
        }

        // Add details for failed tests
        for (const test of suite.tests) {
          if (test.errors && test.errors.length > 0) {
            report += `**${test.name}** - Errors:\n`;
            for (const err of test.errors) {
              report += `- ${err}\n`;
            }
            report += `\n`;
          }
        }
      }

      report += `---\n\n`;
      report += `## Summary\n\n`;
      report += `- **Tests:** ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped\n`;
      report += `- **Duration:** ${testResults.duration}\n`;
    } catch {}
  }

  const allPassed = hugoStatus === 'PASSED' && cssStatus === 'PASSED' && htmlStatus === 'PASSED' && testStatus === 'PASSED';
  const allSkippedOrPassed = ['PASSED', 'SKIPPED'].includes(hugoStatus) &&
                              ['PASSED', 'SKIPPED'].includes(cssStatus) &&
                              ['PASSED', 'SKIPPED'].includes(htmlStatus) &&
                              ['PASSED', 'SKIPPED'].includes(testStatus) &&
                              !['FAILED'].includes(hugoStatus) &&
                              !['FAILED'].includes(cssStatus) &&
                              !['FAILED'].includes(htmlStatus) &&
                              !['FAILED'].includes(testStatus);

  report += `\n---\n\n`;
  report += allSkippedOrPassed ? `## ✅ All validations passed\n` : `## ❌ Some validations failed\n`;

  fs.writeFileSync(config.reportFilename, report);
  console.log(`Generated ${config.reportFilename}`);
}

/**
 * Clean up old reports, keeping only the most recent N
 */
function cleanupOldReports(config) {
  const reportsDir = config.reportsDir;
  if (!fs.existsSync(reportsDir)) return;

  try {
    const reports = fs.readdirSync(reportsDir)
      .filter(f => fs.statSync(path.join(reportsDir, f)).isDirectory())
      .sort()
      .reverse();

    // Remove old reports beyond retention limit
    for (let i = config.reportRetention; i < reports.length; i++) {
      const reportPath = path.join(reportsDir, reports[i]);
      fs.rmSync(reportPath, { recursive: true, force: true });
    }
  } catch {}
}

module.exports = {
  validate,
  clearCache,
  runTests,
  // Exported for unit tests
  globToRegex,
  globBase,
  walkFiles,
  computeDigest,
  getStageInputs,
  planStage,
  statusToCache,
  formatDuration,
  isPreCommitHook,
  listHtmlFiles,
  findListeners,
  parseSsPids,
  parsePidList,
  hasCommand,
  loadCache,
  CACHE_VERSION,
};
