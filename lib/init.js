const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { detectHugoConfig, CONFIG_FILENAME, VALIDATOR_DIR, getDefaultConfig } = require('./config');
const { setupHooks } = require('./hooks');

/**
 * Initialize hugo-validator in a project
 */
async function init(options = {}) {
  const projectRoot = process.cwd();
  const validatorDir = path.join(projectRoot, VALIDATOR_DIR);

  console.log('Initializing hugo-validator...\n');

  // Create hugo-validator directory if it doesn't exist
  if (!fs.existsSync(validatorDir)) {
    fs.mkdirSync(validatorDir, { recursive: true });
    console.log(`\u2705 Created ${VALIDATOR_DIR}/ directory`);
  }

  // 1. Detect Hugo configuration
  const hugoConfig = detectHugoConfig(projectRoot);
  if (hugoConfig) {
    console.log(`\u2705 Found Hugo config: ${hugoConfig.configFile}`);
    console.log(`   Site URL: ${hugoConfig.baseUrl}`);
  } else {
    console.log('\u26A0\uFE0F  No Hugo config found - using default site URL');
  }

  // 2. Create configuration file
  const configPath = path.join(validatorDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !options.force) {
    console.log(`\u2139\uFE0F  ${VALIDATOR_DIR}/${CONFIG_FILENAME} already exists (use --force to overwrite)`);
  } else {
    const configContent = generateConfigFile(hugoConfig?.baseUrl);
    fs.writeFileSync(configPath, configContent);
    console.log(`\u2705 Created ${VALIDATOR_DIR}/${CONFIG_FILENAME}`);
  }

  // 3. Set up git hooks
  if (!options.skipHooks) {
    await setupHooks(options);
  }

  // 4. Create/update linting configs
  await setupLintingConfigs(validatorDir, options);

  // 5. Update package.json scripts
  await updatePackageJson(projectRoot);

  // 6. Update .gitignore
  // Tests and the Playwright config are not created here: the package syncs
  // them into hugo-validator/.runtime/ (gitignored) on every run.
  await updateGitignore(projectRoot);

  console.log('\n\u2705 hugo-validator initialized successfully!\n');
  console.log('Next steps:');
  console.log(`  1. Edit ${VALIDATOR_DIR}/${CONFIG_FILENAME} with your site-specific settings`);
  console.log('  2. Run: npx --no hugo-validator validate');
  console.log('  3. Commit your changes - the pre-commit hook will run automatically\n');
}

/**
 * Generate config file content
 */
function generateConfigFile(siteUrl = 'https://example.com') {
  return `// hugo-validator configuration
// See: https://github.com/thedavecarroll/hugo-validator

module.exports = {
  // Required: Your site's URL (used to skip self-referential links)
  siteUrl: '${siteUrl}',

  // Ports to kill before validation (dev servers that might conflict)
  portsToKill: [1313, 3000],

  // External domains to skip in link checking
  // Key is domain, value is reason for skipping
  skipExternalDomains: {
    // 'challenges.cloudflare.com': 'Cloudflare Turnstile widget',
    // 'web.archive.org': 'Archive.org rate-limits automated requests',
  },

  // CSS validation: glob pattern for SCSS/CSS files
  cssPattern: 'themes/*/assets/scss/**/*.scss',

  // HTML validation: globs under public/ to leave out
  htmlValidation: {
    exclude: ['**/page/*/index.html'], // Hugo pagination redirect pages
  },

  // Paths to skip in accessibility and link tests
  skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],

  // Accessibility testing: pages are split into parallel tests. 0 = automatic
  accessibility: {
    shards: 0,
  },

  // Parallel Playwright workers: a number or a percentage of CPU cores
  testWorkers: '80%',

  // Link testing configuration
  links: {
    // Broken external links are reported as warnings. true = they fail validation
    failOnExternal: false,
    // true = accept expired or self-signed certificates
    ignoreHTTPSErrors: false,
  },

  // Responsive testing configuration
  responsive: {
    // CSS selector for your main page wrapper
    wrapperSelector: '.page-wrapper',
    // Pages to spot-check for responsive layout issues
    spotCheckPages: ['/', '/posts/', '/about/'],
    // false = elements outside the wrapper are reported as warnings
    failOnWrapperOverflow: true,
  },

  // Interaction testing configuration
  interaction: {
    // CSS selector for main navigation links
    navSelector: '.site-nav a',
    // Selectors for touch target size testing
    touchTargetSelectors: [
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      'nav a',
    ],
    // Minimum touch target in px: 24 = WCAG 2.2 AA (2.5.8), 44 = AAA (2.5.5)
    minTouchTarget: 24,
    // false = small touch targets are reported as warnings
    failOnTouchTargets: true,
  },

  // Report settings
  reportRetention: 8,                    // Number of reports to keep
  reportFilename: 'VALIDATION-REPORT.md', // Main report filename
  reportsDir: 'hugo-validator/reports',  // Directory for timestamped reports

  // Test server: the built-in Node server serves public/ on this port
  testServerPort: 3000,
  // testServerCommand: 'caddy file-server --listen :3000 --root ../public', // only to replace the built-in server

  // Browser for the tests. Default: Playwright's bundled Chromium.
  // On a machine where that cannot run, point at a system browser
  // (or set the HUGO_VALIDATOR_BROWSER environment variable):
  // browserExecutable: '/usr/bin/chromium',
};
`;
}

/**
 * Set up linting configuration files
 */
async function setupLintingConfigs(validatorDir, options) {
  // Stylelint config
  const stylelintPath = path.join(validatorDir, '.stylelintrc.json');
  if (!fs.existsSync(stylelintPath) || options.force) {
    const stylelintConfig = {
      extends: ['hugo-validator/configs/stylelint'],
      rules: {},
    };
    fs.writeFileSync(stylelintPath, JSON.stringify(stylelintConfig, null, 2) + '\n');
    console.log(`\u2705 Created ${VALIDATOR_DIR}/.stylelintrc.json`);
  } else {
    console.log(`\u2139\uFE0F  ${VALIDATOR_DIR}/.stylelintrc.json already exists`);
  }

  // HTML validate config
  const htmlValidatePath = path.join(validatorDir, '.htmlvalidate.json');
  if (!fs.existsSync(htmlValidatePath) || options.force) {
    const htmlValidateConfig = {
      extends: ['hugo-validator/configs/htmlvalidate'],
      rules: {},
    };
    fs.writeFileSync(htmlValidatePath, JSON.stringify(htmlValidateConfig, null, 2) + '\n');
    console.log(`\u2705 Created ${VALIDATOR_DIR}/.htmlvalidate.json`);
  } else {
    console.log(`\u2139\uFE0F  ${VALIDATOR_DIR}/.htmlvalidate.json already exists`);
  }
}

/**
 * npm scripts every site gets. All of them go through the package.
 */
const NPM_SCRIPTS = {
  validate: 'hugo-validator validate',
  'validate:hugo': 'hugo-validator validate --only hugo',
  'validate:css': 'hugo-validator validate --only css',
  'validate:html': 'hugo-validator validate --only html',
  'validate:tests': 'hugo-validator validate --only tests',
  test: 'hugo-validator test',
  'test:links': 'hugo-validator test links',
  'test:a11y': 'hugo-validator test a11y',
  'test:ui': 'hugo-validator test --ui',
};

/**
 * Update package.json with validation scripts.
 * options.force overwrites scripts that exist with a different command (used by migrate).
 */
async function updatePackageJson(projectRoot, options = {}) {
  const packagePath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(packagePath)) {
    console.log('\u26A0\uFE0F  No package.json found - skipping script setup');
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts || {};
  const changed = [];

  for (const [name, command] of Object.entries(NPM_SCRIPTS)) {
    if (scripts[name] === command) continue;
    if (!scripts[name] || options.force) {
      scripts[name] = command;
      changed.push(name);
    }
  }

  if (changed.length > 0) {
    pkg.scripts = scripts;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`\u2705 Set npm scripts in package.json: ${changed.join(', ')}`);
  } else {
    console.log('\u2139\uFE0F  npm scripts already up to date in package.json');
  }
}

/**
 * Update .gitignore with validation-related entries
 */
async function updateGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  const entriesToAdd = [
    'hugo-validator/.runtime/',
    'hugo-validator/reports/',
    'hugo-validator/.validation-cache.json',
    'VALIDATION-REPORT.md',
  ];

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
  }

  const lines = content.split('\n');
  const newEntries = [];

  for (const entry of entriesToAdd) {
    if (!lines.some(line => line.trim() === entry)) {
      newEntries.push(entry);
    }
  }

  if (newEntries.length > 0) {
    const addition = '\n# hugo-validator\n' + newEntries.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, addition);
    console.log(`\u2705 Added ${newEntries.length} entries to .gitignore`);
  } else {
    console.log('\u2139\uFE0F  .gitignore already has validation entries');
  }
}

module.exports = { init, updatePackageJson, updateGitignore, NPM_SCRIPTS };
