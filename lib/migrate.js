// Remove what older hugo-validator setups (and the shell pipeline before
// them) left in a site. Everything listed here is either generated output or
// a copy of something this package now owns.
const fs = require('fs');
const path = require('path');
const { VALIDATOR_DIR } = require('./config');

const VALIDATOR_TEST_FILES = new Set([
  'a11y.spec.ts', 'interaction.spec.ts', 'links.spec.ts', 'responsive.spec.ts',
  'summary-reporter.ts', 'helpers.ts',
]);

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** True when a folder holds nothing but hugo-validator's own test files */
function isValidatorTestsDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const files = entries.filter(name => name !== '.DS_Store');
  return files.length > 0 && files.every(name => VALIDATOR_TEST_FILES.has(name));
}

/**
 * Legacy artefacts present in a site: [{ path, reason }]
 * Only things that are recognisably ours are listed. Anything ambiguous is left alone.
 */
function findLegacy(projectRoot = process.cwd()) {
  const at = (...parts) => path.join(projectRoot, ...parts);
  const found = [];
  const add = (relative, reason) => found.push({ path: relative, reason });

  if (isValidatorTestsDir(at(VALIDATOR_DIR, 'tests'))) {
    add(`${VALIDATOR_DIR}/tests`, 'copied tests (now synced from the package at run time)');
  }
  if (fs.existsSync(at(VALIDATOR_DIR, 'playwright.config.ts'))) {
    add(`${VALIDATOR_DIR}/playwright.config.ts`, 'Playwright config (now generated at run time)');
  }
  if (fs.existsSync(at(VALIDATOR_DIR, 'test-results'))) {
    add(`${VALIDATOR_DIR}/test-results`, 'old test output (now under .runtime/)');
  }

  if (isValidatorTestsDir(at('tests'))) add('tests', 'root copy of the validator tests');
  if (/summary-reporter|http\.server/.test(read(at('playwright.config.ts')))) {
    add('playwright.config.ts', 'root Playwright config from the old pipeline');
  }

  // Root linter configs are duplicates only when the validator's own copies exist
  for (const name of ['.stylelintrc.json', '.htmlvalidate.json']) {
    if (fs.existsSync(at(name)) && fs.existsSync(at(VALIDATOR_DIR, name))) {
      add(name, `duplicate of ${VALIDATOR_DIR}/${name}`);
    }
  }

  for (const name of ['.validation-reports', '.playwright-report', 'playwright-report', 'test-results']) {
    if (fs.existsSync(at(name))) add(name, 'output of the old shell pipeline');
  }

  if (/\.githooks\/pre-commit/.test(read(at('scripts', 'validate.sh')))) {
    add('scripts/validate.sh', 'wrapper around the old pre-commit hook (use: npm run validate)');
  }

  const hook = read(at('.githooks', 'pre-commit'));
  if (hook && !/hugo-validator/.test(hook)) {
    add('.githooks/pre-commit', 'old shell pipeline hook (replaced by the generated hook)');
  }

  return found;
}

/**
 * List legacy artefacts, and with options.yes remove them and bring the npm
 * scripts, hook and .gitignore up to date.
 */
async function migrate(options = {}) {
  const projectRoot = process.cwd();
  const { setupHooks } = require('./hooks');
  const { updatePackageJson, updateGitignore } = require('./init');

  const legacy = findLegacy(projectRoot);
  if (legacy.length === 0) {
    console.log('✅ No legacy files found');
  } else {
    console.log(options.yes ? 'Removing legacy files:' : 'Legacy files found:');
    for (const item of legacy) console.log(`  ${item.path}  -  ${item.reason}`);
  }

  if (!options.yes) {
    console.log('\nNothing was changed. Re-run with --yes to remove these, regenerate the');
    console.log('pre-commit hook, and point the npm scripts at hugo-validator.');
    console.log('Tracked files stay recoverable from git.');
    return legacy;
  }

  for (const item of legacy) {
    fs.rmSync(path.join(projectRoot, item.path), { recursive: true, force: true });
  }

  console.log('');
  await setupHooks({ force: true });
  await updatePackageJson(projectRoot, { force: true });
  await updateGitignore(projectRoot);
  console.log('\n✅ Migration complete. Run: npx hugo-validator doctor');
  return legacy;
}

module.exports = { migrate, findLegacy, isValidatorTestsDir };
