const fs = require('fs');
const path = require('path');

const VALIDATOR_DIR = 'hugo-validator';
const CONFIG_FILENAME = 'hugo-validator.config.js';

/**
 * Get the default configuration
 */
function getDefaultConfig() {
  return {
    // Required: Site URL for skipping self-referential links
    siteUrl: 'https://example.com',

    // Ports to kill before validation
    portsToKill: [1313, 3000],

    // External domains to skip in link checking
    skipExternalDomains: {},

    // CSS validation pattern
    cssPattern: 'themes/*/assets/scss/**/*.scss',

    // HTML validation settings (all of public/**/*.html is validated)
    htmlValidation: {
      exclude: [
        '**/page/*/index.html', // Hugo pagination redirect pages
      ],
    },

    // Paths to skip in accessibility and link tests
    skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],

    // Accessibility test settings
    accessibility: {
      shards: 0, // parallel accessibility tests. 0 = automatic (about 40% of CPU cores)
    },

    // Link test settings
    links: {
      failOnExternal: false, // Broken external links are warnings. true = they fail validation
      ignoreHTTPSErrors: false, // true = accept expired or self-signed certificates
    },

    // Responsive test settings
    responsive: {
      wrapperSelector: '.page-wrapper',
      spotCheckPages: ['/', '/posts/', '/about/'],
      failOnWrapperOverflow: true, // false = report as warnings
    },

    // Interaction test settings
    interaction: {
      navSelector: '.site-nav a',
      touchTargetSelectors: [
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        'nav a',
        '.footer-icons a',
      ],
      minTouchTarget: 24, // px. 24 = WCAG 2.2 AA (2.5.8), 44 = AAA (2.5.5)
      failOnTouchTargets: true, // false = report as warnings
    },

    // Report settings
    generateReport: true, // Set to false to disable VALIDATION-REPORT.md
    reportRetention: 8,
    reportFilename: 'VALIDATION-REPORT.md',
    reportsDir: 'hugo-validator/reports',

    // Parallel Playwright workers: a number or a percentage of CPU cores.
    // null = Playwright's default (50%). Ignored when CI is set.
    testWorkers: '80%',

    // Test server settings
    testServerPort: 3000,
    testServerCommand: null, // null = the built-in Node server. A custom command runs from <site>/hugo-validator

    // Browser for the tests. null = Playwright's bundled Chromium.
    // Set a path such as '/usr/bin/chromium' (or env HUGO_VALIDATOR_BROWSER) to use a system browser
    browserExecutable: null,
  };
}

/**
 * Load configuration from project root
 * @param {string} [projectRoot] - Project root directory (defaults to cwd)
 * @returns {object} Merged configuration
 */
function loadConfig(projectRoot = process.cwd()) {
  const configPath = path.join(projectRoot, VALIDATOR_DIR, CONFIG_FILENAME);
  const defaults = getDefaultConfig();

  if (!fs.existsSync(configPath)) {
    console.warn(`Warning: ${CONFIG_FILENAME} not found, using defaults`);
    return defaults;
  }

  try {
    // Clear require cache to get fresh config
    delete require.cache[require.resolve(configPath)];
    const userConfig = require(configPath);

    // Deep merge configuration
    return deepMerge(defaults, userConfig);
  } catch (error) {
    console.error(`Error loading ${CONFIG_FILENAME}:`, error.message);
    return defaults;
  }
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Detect Hugo config and extract site URL
 */
function detectHugoConfig(projectRoot = process.cwd()) {
  const configFiles = ['hugo.yaml', 'hugo.toml', 'hugo.json', 'config.yaml', 'config.toml', 'config.json'];

  for (const filename of configFiles) {
    const configPath = path.join(projectRoot, filename);
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');

      // Try to extract baseURL
      let baseUrl = null;

      if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
        const match = content.match(/baseURL:\s*["']?([^"'\s\n]+)/i);
        if (match) baseUrl = match[1];
      } else if (filename.endsWith('.toml')) {
        const match = content.match(/baseURL\s*=\s*["']([^"']+)/i);
        if (match) baseUrl = match[1];
      } else if (filename.endsWith('.json')) {
        try {
          const json = JSON.parse(content);
          baseUrl = json.baseURL || json.baseUrl;
        } catch {}
      }

      if (baseUrl) {
        return { configFile: filename, baseUrl };
      }
    }
  }

  return null;
}

module.exports = {
  loadConfig,
  deepMerge,
  getDefaultConfig,
  detectHugoConfig,
  CONFIG_FILENAME,
  VALIDATOR_DIR,
};
