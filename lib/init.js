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

  // 6. Create playwright.config.ts if it doesn't exist
  await setupPlaywrightConfig(validatorDir, options);

  // 7. Copy tests to project
  await copyTests(validatorDir, options);

  // 8. Update .gitignore
  await updateGitignore(projectRoot);

  console.log('\n\u2705 hugo-validator initialized successfully!\n');
  console.log('Next steps:');
  console.log(`  1. Edit ${VALIDATOR_DIR}/${CONFIG_FILENAME} with your site-specific settings`);
  console.log('  2. Run: npx hugo-validator validate');
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

  // Paths to skip in accessibility and link tests
  skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],

  // Responsive testing configuration
  responsive: {
    // CSS selector for your main page wrapper
    wrapperSelector: '.page-wrapper',
    // Pages to spot-check for responsive layout issues
    spotCheckPages: ['/', '/posts/', '/about/'],
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
  },

  // Report settings
  reportRetention: 8,                    // Number of reports to keep
  reportFilename: 'VALIDATION-REPORT.md', // Main report filename
  reportsDir: 'hugo-validator/reports',  // Directory for timestamped reports

  // Test server settings
  testServerPort: 3000,
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
 * Update package.json with validation scripts
 */
async function updatePackageJson(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(packagePath)) {
    console.log('\u26A0\uFE0F  No package.json found - skipping script setup');
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts || {};

  let updated = false;

  const newScripts = {
    validate: 'hugo-validator validate',
    'validate:css': 'hugo-validator validate --only css',
    'validate:html': 'hugo-validator validate --only html',
    'validate:hugo': 'hugo-validator validate --only hugo',
    test: 'playwright test --config hugo-validator/playwright.config.ts',
    'test:links': 'playwright test --config hugo-validator/playwright.config.ts links',
    'test:a11y': 'playwright test --config hugo-validator/playwright.config.ts a11y',
    'test:ui': 'playwright test --config hugo-validator/playwright.config.ts --ui',
  };

  for (const [name, command] of Object.entries(newScripts)) {
    if (!scripts[name]) {
      scripts[name] = command;
      updated = true;
    }
  }

  if (updated) {
    pkg.scripts = scripts;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('\u2705 Added npm scripts to package.json');
  } else {
    console.log('\u2139\uFE0F  npm scripts already exist in package.json');
  }
}

/**
 * Set up Playwright configuration
 */
async function setupPlaywrightConfig(validatorDir, options) {
  const configPath = path.join(validatorDir, 'playwright.config.ts');

  if (fs.existsSync(configPath) && !options.force) {
    console.log(`\u2139\uFE0F  ${VALIDATOR_DIR}/playwright.config.ts already exists`);
    return;
  }

  const configContent = `import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const BASE_URL = \`http://localhost:\${PORT}\`;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['./tests/summary-reporter.ts'],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: \`python3 -m http.server \${PORT} --directory ../public\`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
`;

  fs.writeFileSync(configPath, configContent);
  console.log(`\u2705 Created ${VALIDATOR_DIR}/playwright.config.ts`);
}

/**
 * Copy test files to project
 */
async function copyTests(validatorDir, options) {
  const testsDir = path.join(validatorDir, 'tests');

  if (!fs.existsSync(testsDir)) {
    fs.mkdirSync(testsDir, { recursive: true });
  }

  // Get path to our tests directory
  const packageTestsDir = path.join(__dirname, '..', 'tests');

  if (!fs.existsSync(packageTestsDir)) {
    console.log('\u26A0\uFE0F  Package tests directory not found');
    return;
  }

  const testFiles = fs.readdirSync(packageTestsDir).filter(f => f.endsWith('.ts'));

  let copied = 0;
  for (const file of testFiles) {
    const destPath = path.join(testsDir, file);
    if (!fs.existsSync(destPath) || options.force) {
      fs.copyFileSync(path.join(packageTestsDir, file), destPath);
      copied++;
    }
  }

  if (copied > 0) {
    console.log(`\u2705 Copied ${copied} test files to ${VALIDATOR_DIR}/tests/`);
  } else {
    console.log(`\u2139\uFE0F  Test files already exist in ${VALIDATOR_DIR}/tests/`);
  }
}

/**
 * Update .gitignore with validation-related entries
 */
async function updateGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  const entriesToAdd = [
    'hugo-validator/reports/',
    'hugo-validator/test-results/',
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

module.exports = { init };
