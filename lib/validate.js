const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./config');

const CACHE_FILE = 'hugo-validator/.validation-cache.json';

/**
 * Load validation cache
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return { tests: {}, fileHashes: {}, lastRun: null };
}

/**
 * Save validation cache
 */
function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('Warning: Could not save cache:', e.message);
  }
}

/**
 * Compute hash of a file
 */
function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Get file patterns for each stage
 */
function getStageFilePatterns(config) {
  return {
    hugo: ['hugo.yaml', 'hugo.toml', 'config.yaml', 'config.toml', 'content/**/*', 'layouts/**/*', 'themes/**/layouts/**/*', 'data/**/*'],
    css: [config.cssPattern],
    html: ['public/**/*.html', 'layouts/**/*', 'themes/**/layouts/**/*'],
    tests: ['hugo-validator/tests/**/*', 'public/**/*'],
  };
}

/**
 * Get relevant files for a stage using glob patterns
 */
function getFilesForStage(stage, config) {
  const patterns = getStageFilePatterns(config)[stage] || [];
  const files = [];

  for (const pattern of patterns) {
    try {
      // Use find command to get files matching pattern
      const basePath = pattern.split('*')[0].replace(/\/$/, '') || '.';
      if (fs.existsSync(basePath)) {
        const output = execSync(`find ${basePath} -type f 2>/dev/null | head -500`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        files.push(...output.trim().split('\n').filter(f => f));
      }
    } catch {}
  }

  return [...new Set(files)]; // Deduplicate
}

/**
 * Check if files have changed since last run
 */
function hasFilesChanged(stage, config, cache) {
  const files = getFilesForStage(stage, config);
  const cachedHashes = cache.fileHashes[stage] || {};
  const currentHashes = {};
  let changed = false;

  for (const file of files.slice(0, 100)) { // Limit to 100 files per stage for performance
    const hash = hashFile(file);
    if (hash) {
      currentHashes[file] = hash;
      if (cachedHashes[file] !== hash) {
        changed = true;
      }
    }
  }

  // Check for deleted files
  for (const file of Object.keys(cachedHashes)) {
    if (!currentHashes[file]) {
      changed = true;
    }
  }

  return { changed, hashes: currentHashes };
}

/**
 * Detect if running in pre-commit hook context
 */
function isPreCommitHook() {
  return process.env.HUSKY_GIT_PARAMS !== undefined ||
         process.env.PRE_COMMIT === '1' ||
         process.env.GIT_HOOK === '1';
}

/**
 * Run the validation pipeline
 * @param {object} options - CLI options
 * @returns {number} Exit code (0 = success, 1 = failure)
 */
async function validate(options = {}) {
  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19).replace('T', '_');
  const reportDir = path.join(config.reportsDir, timestamp);

  // Determine mode
  const isPreCommit = isPreCommitHook();
  const isInteractive = options.interactive || (!isPreCommit && !options.full);
  const forceAll = options.full || options.force || isPreCommit;

  // Load cache for smart skipping
  const cache = loadCache();

  // Kill dev servers unless --no-kill
  if (options.kill !== false) {
    killPorts(config.portsToKill);
  }

  if (isInteractive && !forceAll) {
    console.log('Running validators (smart mode - skipping unchanged)...\n');
  } else {
    console.log('Running validators...\n');
  }

  // Create reports directory
  if (options.report !== false) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  let failed = false;
  let anyTestsRan = false;
  const results = {
    hugo: { status: 'skipped', log: '' },
    css: { status: 'skipped', log: '' },
    html: { status: 'skipped', log: '' },
    tests: { status: 'skipped', log: '' },
  };

  // Run stages based on --only option
  const stages = options.only ? [options.only] : ['hugo', 'css', 'html', 'tests'];

  for (const stage of stages) {
    // Smart skip logic for interactive mode
    let shouldRun = forceAll;
    let skipReason = null;

    if (!forceAll && isInteractive) {
      const fileCheck = hasFilesChanged(stage, config, cache);
      const previousResult = cache.tests[stage];

      if (previousResult === 'passed' && !fileCheck.changed) {
        shouldRun = false;
        skipReason = 'unchanged';
      } else {
        shouldRun = true;
        // Update file hashes in cache
        cache.fileHashes[stage] = fileCheck.hashes;
      }
    } else {
      shouldRun = true;
    }

    if (!shouldRun) {
      console.log(`⏭️  ${stage} (skipped - ${skipReason})`);
      results[stage] = { status: 'skipped', log: `Skipped: ${skipReason}` };
      continue;
    }

    anyTestsRan = true;

    switch (stage) {
      case 'hugo':
        results.hugo = await runHugoBuild(reportDir, options.report !== false);
        cache.tests.hugo = results.hugo.status;
        if (results.hugo.status === 'failed') failed = true;
        break;

      case 'css':
        results.css = await runCssValidation(config, reportDir, options.report !== false);
        cache.tests.css = results.css.status;
        if (results.css.status === 'failed') failed = true;
        break;

      case 'html':
        results.html = await runHtmlValidation(config, reportDir, options.report !== false);
        cache.tests.html = results.html.status;
        if (results.html.status === 'failed') failed = true;
        break;

      case 'tests':
        // Use --last-failed in interactive mode when previous run had failures
        const useLastFailed = isInteractive && !forceAll && cache.tests.tests === 'failed';
        results.tests = await runPlaywrightTests(config, reportDir, options.report !== false, useLastFailed);
        cache.tests.tests = results.tests.status;
        if (results.tests.status === 'failed') failed = true;
        break;

      default:
        console.error(`Unknown stage: ${stage}`);
        console.error('Valid stages: hugo, css, html, tests');
        return 1;
    }
  }

  // Save cache after run
  cache.lastRun = new Date().toISOString();
  saveCache(cache);

  // Generate report (check both CLI option and config setting)
  const shouldGenerateReport = options.report !== false && config.generateReport !== false;
  if (shouldGenerateReport) {
    generateReport(config, results, reportDir, timestamp);
    cleanupOldReports(config);
  }

  console.log('');

  // In interactive mode, if all passed, suggest running full validation
  if (!failed && isInteractive && !forceAll && !anyTestsRan) {
    console.log(`✅ All tests previously passed (no changes detected)`);
    console.log(`   Run with --full to force all tests`);
    return 0;
  }

  if (failed) {
    console.log(`❌ Validation failed`);
    if (shouldGenerateReport) {
      console.log(`   See: ${config.reportFilename}`);
    }
    if (isInteractive && !forceAll) {
      console.log(`\n   Fix issues and re-run. Only failed tests will run.`);
    }
    return 1;
  }

  console.log(`✅ All validations passed`);
  if (shouldGenerateReport) {
    console.log(`   Report: ${config.reportFilename}`);
  }
  return 0;
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

/**
 * Kill processes on specified ports
 */
function killPorts(ports) {
  for (const port of ports) {
    // Validate port is a number to prevent command injection
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) continue;
    try {
      execSync(`lsof -ti:${portNum} 2>/dev/null | xargs kill 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // Ignore errors - port may not be in use
    }
  }
  // Give processes time to exit
  execSync('sleep 1', { stdio: 'ignore' });
}

/**
 * Run Hugo build
 */
async function runHugoBuild(reportDir, saveLog) {
  try {
    const output = execSync('hugo --panicOnWarning', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('✅ Hugo build');

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'hugo-build.log'), output);
    }

    return { status: 'passed', log: output };
  } catch (error) {
    console.log('❌ Hugo build failed (or has warnings)');
    console.log(`   See: ${reportDir}/hugo-build.log`);

    const output = (error.stdout || '') + (error.stderr || '') || error.message;
    console.log(output);

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'hugo-build.log'), output);
    }

    return { status: 'failed', log: output };
  }
}

/**
 * Run CSS validation with stylelint
 */
async function runCssValidation(config, reportDir, saveLog) {
  // Escape single quotes in pattern to prevent command injection
  const safePattern = config.cssPattern.replace(/'/g, "'\\''");
  try {
    const output = execSync(
      `npx stylelint --config hugo-validator/.stylelintrc.json --formatter verbose '${safePattern}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log('✅ CSS validation');

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'css-validation.log'), output);
    }

    return { status: 'passed', log: output };
  } catch (error) {
    console.log('❌ CSS validation failed');
    console.log(`   See: ${reportDir}/css-validation.log`);

    const output = error.stdout || error.stderr || error.message;
    console.log(output);

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'css-validation.log'), output);
    }

    return { status: 'failed', log: output };
  }
}

/**
 * Run HTML validation
 */
async function runHtmlValidation(config, reportDir, saveLog) {
  try {
    // Count HTML files
    let htmlCount = 0;
    try {
      const countOutput = execSync('find public -name "*.html" | wc -l', { encoding: 'utf8' });
      htmlCount = parseInt(countOutput.trim(), 10);
    } catch {}

    // Build find command with exclude patterns
    let findCmd = 'find public -name "*.html"';
    const excludes = config.htmlValidation?.exclude || [];
    for (const pattern of excludes) {
      // Convert glob to find pattern (e.g., **/page/*/index.html -> */page/*/index.html)
      const findPattern = pattern.replace(/^\*\*\//, '*/');
      findCmd += ` -not -path '${findPattern}'`;
    }
    findCmd += ' | xargs npx html-validate --config hugo-validator/.htmlvalidate.json --formatter stylish';

    const output = execSync(findCmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    console.log('✅ HTML validation');

    const logContent = `Validating ${htmlCount} HTML files...\n${output}\n${htmlCount} files validated, 0 errors`;

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'html-validation.log'), logContent);
    }

    return { status: 'passed', log: logContent };
  } catch (error) {
    console.log('❌ HTML validation failed');
    console.log(`   See: ${reportDir}/html-validation.log`);

    const output = error.stdout || error.stderr || error.message;
    console.log(output);

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'html-validation.log'), output);
    }

    return { status: 'failed', log: output };
  }
}

/**
 * Run Playwright tests
 * @param {boolean} lastFailedOnly - If true, only run previously failed tests
 */
async function runPlaywrightTests(config, reportDir, saveLog, lastFailedOnly = false) {
  return new Promise((resolve) => {
    const args = ['playwright', 'test', '--config', 'hugo-validator/playwright.config.ts'];

    if (lastFailedOnly) {
      args.push('--last-failed');
      console.log('Running Playwright tests (failed tests only)...');
    } else {
      console.log('Running Playwright tests...');
    }

    const playwright = spawn('npx', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';

    playwright.stdout.on('data', (data) => {
      output += data.toString();
    });

    playwright.stderr.on('data', (data) => {
      output += data.toString();
    });

    playwright.on('close', (code) => {
      // Display formatted results from results.json
      const resultsPath = path.join('hugo-validator', 'test-results', 'results.json');
      if (fs.existsSync(resultsPath)) {
        try {
          const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
          console.log('');

          for (const suite of results.suites) {
            console.log(`\n📋 ${suite.suite}`);
            for (const test of suite.tests) {
              const icon = test.status === 'passed' ? '✅' : test.status === 'failed' ? '❌' : '⏭️';
              console.log(`   ${icon} ${test.name} (${test.duration})`);
              for (const line of test.output) {
                console.log(`      ${line}`);
              }
              for (const err of test.errors) {
                console.log(`      ❗ ${err}`);
              }
            }
          }

          console.log(`\n📊 Summary: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped (${results.duration})`);
          console.log('');

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

      if (saveLog) {
        fs.writeFileSync(path.join(reportDir, 'playwright.log'), output);
      }

      if (code !== 0) {
        console.log('❌ Playwright tests failed');
        console.log(`   See: ${reportDir}/playwright.log`);
        resolve({ status: 'failed', log: output });
      } else {
        console.log('✅ Playwright tests');
        resolve({ status: 'passed', log: output });
      }
    });
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
${results.css.log.trim() || 'Not run'}
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
          const icon = test.status === 'passed' ? '✅' : test.status === 'failed' ? '❌' : '⏭️';
          report += `| ${test.name} | ${icon} | ${test.duration} |\n`;
        }
        report += `\n`;

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

module.exports = { validate, clearCache };
