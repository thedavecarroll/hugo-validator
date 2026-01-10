const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

/**
 * Run the validation pipeline
 * @param {object} options - CLI options
 * @returns {number} Exit code (0 = success, 1 = failure)
 */
async function validate(options = {}) {
  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19).replace('T', '_');
  const reportDir = path.join(config.reportsDir, timestamp);

  // Kill dev servers unless --no-kill
  if (options.kill !== false) {
    killPorts(config.portsToKill);
  }

  console.log('Running validators...\n');

  // Create reports directory
  if (options.report !== false) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  let failed = false;
  const results = {
    hugo: { status: 'skipped', log: '' },
    css: { status: 'skipped', log: '' },
    html: { status: 'skipped', log: '' },
    tests: { status: 'skipped', log: '' },
  };

  // Run stages based on --only option
  const stages = options.only ? [options.only] : ['hugo', 'css', 'html', 'tests'];

  for (const stage of stages) {
    switch (stage) {
      case 'hugo':
        results.hugo = await runHugoBuild(reportDir, options.report !== false);
        if (results.hugo.status === 'failed') failed = true;
        break;

      case 'css':
        results.css = await runCssValidation(config, reportDir, options.report !== false);
        if (results.css.status === 'failed') failed = true;
        break;

      case 'html':
        results.html = await runHtmlValidation(config, reportDir, options.report !== false);
        if (results.html.status === 'failed') failed = true;
        break;

      case 'tests':
        results.tests = await runPlaywrightTests(config, reportDir, options.report !== false);
        if (results.tests.status === 'failed') failed = true;
        break;

      default:
        console.error(`Unknown stage: ${stage}`);
        console.error('Valid stages: hugo, css, html, tests');
        return 1;
    }
  }

  // Generate report
  if (options.report !== false) {
    generateReport(config, results, reportDir, timestamp);
    cleanupOldReports(config);
  }

  console.log('');
  if (failed) {
    console.log(`\u274C Validation failed`);
    console.log(`   See: ${config.reportFilename}`);
    return 1;
  }

  console.log(`\u2705 All validations passed`);
  console.log(`   Report: ${config.reportFilename}`);
  return 0;
}

/**
 * Kill processes on specified ports
 */
function killPorts(ports) {
  for (const port of ports) {
    try {
      execSync(`lsof -ti:${port} 2>/dev/null | xargs kill 2>/dev/null`, { stdio: 'ignore' });
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
    console.log('\u2705 Hugo build');

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'hugo-build.log'), output);
    }

    return { status: 'passed', log: output };
  } catch (error) {
    console.log('\u274C Hugo build failed (or has warnings)');
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
  try {
    const output = execSync(
      `npx stylelint --formatter verbose '${config.cssPattern}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log('\u2705 CSS validation');

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'css-validation.log'), output);
    }

    return { status: 'passed', log: output };
  } catch (error) {
    console.log('\u274C CSS validation failed');
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

    const output = execSync('npx html-validate --formatter stylish public', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log('\u2705 HTML validation');

    const logContent = `Validating ${htmlCount} HTML files...\n${output}\n${htmlCount} files validated, 0 errors`;

    if (saveLog) {
      fs.writeFileSync(path.join(reportDir, 'html-validation.log'), logContent);
    }

    return { status: 'passed', log: logContent };
  } catch (error) {
    console.log('\u274C HTML validation failed');
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
 */
async function runPlaywrightTests(config, reportDir, saveLog) {
  return new Promise((resolve) => {
    console.log('Running Playwright tests...');

    const playwright = spawn('npx', ['playwright', 'test'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
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
      const resultsPath = path.join('test-results', 'results.json');
      if (fs.existsSync(resultsPath)) {
        try {
          const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
          console.log('');

          for (const suite of results.suites) {
            console.log(`\n\u{1F4CB} ${suite.suite}`);
            for (const test of suite.tests) {
              const icon = test.status === 'passed' ? '\u2705' : test.status === 'failed' ? '\u274C' : '\u23ED\uFE0F';
              console.log(`   ${icon} ${test.name} (${test.duration})`);
              for (const line of test.output) {
                console.log(`      ${line}`);
              }
              for (const err of test.errors) {
                console.log(`      \u2757 ${err}`);
              }
            }
          }

          console.log(`\n\u{1F4CA} Summary: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped (${results.duration})`);
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
        console.log('\u274C Playwright tests failed');
        console.log(`   See: ${reportDir}/playwright.log`);
        resolve({ status: 'failed', log: output });
      } else {
        console.log('\u2705 Playwright tests');
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

## Hugo Build: ${hugoStatus === 'PASSED' ? '\u2705 PASSED' : hugoStatus === 'FAILED' ? '\u274C FAILED' : '\u23ED\uFE0F SKIPPED'}

\`\`\`
${results.hugo.log.trim() || 'Not run'}
\`\`\`

---

## CSS Validation: ${cssStatus === 'PASSED' ? '\u2705 PASSED' : cssStatus === 'FAILED' ? '\u274C FAILED' : '\u23ED\uFE0F SKIPPED'}

\`\`\`
${results.css.log.trim() || 'Not run'}
\`\`\`

---

## HTML Validation: ${htmlStatus === 'PASSED' ? '\u2705 PASSED' : htmlStatus === 'FAILED' ? '\u274C FAILED' : '\u23ED\uFE0F SKIPPED'}

\`\`\`
${results.html.log.trim() || 'Not run'}
\`\`\`

---

## Playwright Tests: ${testStatus === 'PASSED' ? '\u2705 PASSED' : testStatus === 'FAILED' ? '\u274C FAILED' : '\u23ED\uFE0F SKIPPED'}

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
          const icon = test.status === 'passed' ? '\u2705' : test.status === 'failed' ? '\u274C' : '\u23ED\uFE0F';
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
  report += `\n---\n\n`;
  report += allPassed ? `## \u2705 All validations passed\n` : `## \u274C Some validations failed\n`;

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

module.exports = { validate };
