#!/usr/bin/env node

const { program } = require('commander');
const { version } = require('../package.json');
const { init, updateTests } = require('../lib/init');
const { validate, clearCache } = require('../lib/validate');
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
  .command('update-tests')
  .description('Refresh hugo-validator/tests/ from the installed package (config is not touched)')
  .action(async () => {
    try {
      await updateTests();
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
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
