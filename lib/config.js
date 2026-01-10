const fs = require('fs');
const path = require('path');

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

    // HTML validation settings
    htmlValidation: {
      pattern: 'public/**/*.html',
      exclude: null,
    },

    // Paths to skip in accessibility and link tests
    skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],

    // Responsive test settings
    responsive: {
      wrapperSelector: '.page-wrapper',
      spotCheckPages: ['/', '/posts/', '/about/'],
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
    },

    // Report settings
    reportRetention: 8,
    reportFilename: 'VALIDATION-REPORT.md',
    reportsDir: '.validation-reports',

    // Test server settings
    testServerPort: 3000,
    testServerCommand: null, // Auto-generated if null
  };
}

/**
 * Load configuration from project root
 * @param {string} [projectRoot] - Project root directory (defaults to cwd)
 * @returns {object} Merged configuration
 */
function loadConfig(projectRoot = process.cwd()) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
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
  getDefaultConfig,
  detectHugoConfig,
  CONFIG_FILENAME,
};
