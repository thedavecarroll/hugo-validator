#!/usr/bin/env node

const { program } = require('commander');
const { version } = require('../package.json');
const { init } = require('../lib/init');
const { validate, clearCache, runTests } = require('../lib/validate');
const { doctor } = require('../lib/doctor');
const { migrate } = require('../lib/migrate');
const { setupHooks } = require('../lib/hooks');

program
  .name('hugo-validator')
  .description('Comprehensive validation pipeline for Hugo sites')
  .version(version);

program
  .command('init')
  .description('Initialize hugo-validator in your Hugo project')
  .option('--force', 'Overwrite existing configuration files')
  .option('--skip-hooks', 'Skip git hooks setup')
  .action(async (options) => {
    try {
      await init(options);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Run the full validation pipeline')
  .option('--only <stage>', 'Run only a specific stage: hugo, css, html, tests')
  .option('--full', 'Force all tests to run (ignore cache)')
  .option('--force', 'Alias for --full')
  .option('--interactive', 'Deprecated: smart mode (skip unchanged passed stages) is already the default')
  .option('--verbose', 'Include skipped external links in output')
  .option('--no-kill', 'Skip killing dev server processes')
  .option('--no-report', 'Skip report generation')
  .action(async (options) => {
    try {
      const exitCode = await validate(options);
      process.exit(exitCode);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('clear-cache')
  .description('Clear the validation cache (forces all tests to run next time)')
  .action(() => {
    clearCache();
  });

program
  .command('test [filters...]')
  .description('Run the Playwright tests directly, optionally filtered (e.g. "links", "a11y")')
  .option('--ui', 'Open the Playwright UI (needs a display)')
  .action(async (filters, options) => {
    try {
      process.exit(await runTests(filters, options));
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Check that this machine and site are ready: Node, Hugo, browser, packages, config')
  .action(async () => {
    try {
      process.exit(await doctor());
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('migrate')
  .description('List files left by older setups. With --yes, remove them and update hook and npm scripts')
  .option('--yes', 'Apply the changes (without it, nothing is modified)')
  .action(async (options) => {
    try {
      await migrate(options);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('update-tests', { hidden: true })
  .description('Removed: tests are synced from the package on every run')
  .action(() => {
    console.log('update-tests is no longer needed. The tests are synced from the installed');
    console.log('package into hugo-validator/.runtime/ on every run. To remove old committed');
    console.log('copies, run: npx hugo-validator migrate');
  });

program
  .command('setup-hooks')
  .description('Set up git pre-commit hooks')
  .option('--force', 'Overwrite existing hooks')
  .action(async (options) => {
    try {
      await setupHooks(options);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();
