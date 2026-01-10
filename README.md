# hugo-validator

Comprehensive validation pipeline for Hugo sites. Catch broken links, accessibility issues, CSS problems, and more before they hit production.

## Features

- **Pre-commit hooks** - Automatically validate before every commit
- **Link validation** - Check all internal and external links
- **Accessibility testing** - WCAG 2.2 AA compliance with axe-core
- **CSS validation** - Stylelint with SCSS support
- **HTML validation** - html-validate with accessibility rules
- **Responsive testing** - Check for horizontal overflow on mobile/tablet
- **Touch target testing** - Ensure interactive elements meet WCAG 2.2 size requirements
- **Detailed reports** - Timestamped validation reports with full details

## Quick Start

Run these commands **from your Hugo site's root directory** (the folder containing `hugo.yaml` or `hugo.toml`):

```bash
# Navigate to your Hugo site
cd ~/repos/my-hugo-blog

# Install the package (adds to your site's node_modules/)
npm install --save-dev github:thedavecarroll/hugo-validator

# Initialize - creates config files in your site repo
npx hugo-validator init

# Edit the config file with your site settings
nano hugo-validator.config.js

# Run validation manually
npx hugo-validator validate

# Or just commit - the pre-commit hook runs automatically
git commit -m "My changes"
```

### What `init` Creates in Your Site

The `init` command creates these files **in your Hugo site repository** (not in the package):

```
my-hugo-blog/
├── hugo-validator.config.js    # Your site-specific settings
├── .githooks/
│   └── pre-commit              # Git hook (runs validation)
├── .stylelintrc.json           # CSS linting config
├── .htmlvalidate.json          # HTML validation config
├── playwright.config.ts        # Playwright test config
├── tests/                      # Test files (copied from package)
│   ├── links.spec.ts
│   ├── a11y.spec.ts
│   ├── responsive.spec.ts
│   ├── interaction.spec.ts
│   └── summary-reporter.ts
└── node_modules/
    └── hugo-validator/         # The package itself
```

Your `package.json` is also updated with validation scripts.

**Note:** The `init` command **never overwrites existing files**. If a file already exists, it's skipped. Use `--force` to overwrite.

## Requirements

| Tool | Minimum Version | Recommended | Notes |
|------|-----------------|-------------|-------|
| Node.js | 18.0.0 | 20+ | Required for Playwright and ES modules |
| Python | 3.7+ | 3.9+ | Used for the test server (`python3 -m http.server`) |
| Hugo | 0.100.0 | 0.120+ | Older versions may lack `--panicOnWarning` flag |

### Version Check

```bash
node --version   # Should be v18.0.0 or higher
python3 --version   # Should be 3.7 or higher
hugo version     # Should be 0.100.0 or higher
```

### Notes for Older Versions

- **Node.js < 18:** Playwright requires Node.js 18+. You'll see installation errors.
- **Python < 3:** The test server command uses `python3`. On older systems, you may need to install Python 3 or modify the `playwright.config.ts` to use `python` instead.
- **Hugo < 0.100:** The `--panicOnWarning` flag may not be available. Edit `lib/validate.js` if you need to support older Hugo versions.

### Peer Dependencies

The following are installed as peer dependencies when you run `npm install`:
- `@playwright/test` ^1.49.0
- `@axe-core/playwright` ^4.11.0
- `html-validate` ^10.5.0
- `stylelint` ^16.0.0
- `stylelint-config-standard-scss` ^16.0.0

---

## Deep Dive

### Configuration

All settings are in `hugo-validator.config.js`:

```javascript
module.exports = {
  // Required: Your site's URL
  siteUrl: 'https://example.com',

  // Ports to kill before validation (dev servers)
  portsToKill: [1313, 3000],

  // External domains to skip in link checking
  skipExternalDomains: {
    'challenges.cloudflare.com': 'Cloudflare Turnstile widget',
    'web.archive.org': 'Archive.org rate-limits automated requests',
  },

  // CSS validation glob pattern
  cssPattern: 'themes/*/assets/scss/**/*.scss',

  // Paths to skip in accessibility/link tests
  skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],

  // Responsive testing
  responsive: {
    wrapperSelector: '.page-wrapper',
    spotCheckPages: ['/', '/posts/', '/about/'],
  },

  // Interaction testing
  interaction: {
    navSelector: '.site-nav a',
    touchTargetSelectors: ['button', 'input', 'nav a'],
  },

  // Report settings
  reportRetention: 8,
  reportFilename: 'VALIDATION-REPORT.md',
  reportsDir: '.validation-reports',

  // Test server
  testServerPort: 3000,
};
```

### CLI Commands

#### `npx hugo-validator init`

Initialize hugo-validator in your project:

```bash
npx hugo-validator init          # Normal setup (skips existing files)
npx hugo-validator init --force  # Overwrite existing files
npx hugo-validator init --skip-hooks  # Skip git hooks setup
```

#### `npx hugo-validator validate`

Run the full validation pipeline:

```bash
npx hugo-validator validate              # Run all stages
npx hugo-validator validate --only hugo  # Hugo build only
npx hugo-validator validate --only css   # CSS validation only
npx hugo-validator validate --only html  # HTML validation only
npx hugo-validator validate --only tests # Playwright tests only
npx hugo-validator validate --no-kill    # Don't kill dev servers
npx hugo-validator validate --no-report  # Skip report generation
```

#### `npx hugo-validator setup-hooks`

Reinstall git hooks (useful if they get removed):

```bash
npx hugo-validator setup-hooks
npx hugo-validator setup-hooks --force  # Overwrite existing hook
```

### Validation Pipeline

The pipeline runs these stages in order:

1. **Kill dev servers** - Stops Hugo (1313), test server (3000), and any custom ports
2. **Hugo build** - Runs `hugo --panicOnWarning` to catch warnings as errors
3. **CSS validation** - Runs stylelint on your SCSS/CSS files
4. **HTML validation** - Runs html-validate on generated HTML
5. **Playwright tests** - Runs link, accessibility, responsive, and interaction tests

If any stage fails, the commit is blocked (when run as pre-commit hook).

### Test Suites

#### Link Validation (`links.spec.ts`)

- Crawls all internal pages starting from `/`
- Validates all internal links return HTTP 200
- Checks all external links are reachable (2xx/3xx)
- Configurable skip domains for problematic external sites

#### Accessibility (`a11y.spec.ts`)

- Tests all pages for WCAG 2.2 AA compliance
- Uses axe-core for comprehensive accessibility checking
- Includes WCAG 2.0, 2.1, and 2.2 rules
- Reports violations with impact level and affected elements

#### Responsive (`responsive.spec.ts`)

- Tests for horizontal overflow on mobile (iPhone 12 viewport)
- Tests for horizontal overflow on tablet (iPad Mini viewport)
- Spot-checks key pages for content staying within wrapper

#### Interaction (`interaction.spec.ts`)

- Tests touch targets meet 44px minimum (WCAG 2.2)
- Verifies focus indicators are visible
- Tests keyboard navigation (Tab key traversal)

### Reports

Validation generates reports **in your Hugo site directory**:

```
my-hugo-blog/
├── VALIDATION-REPORT.md           # Main report (updated each run)
└── .validation-reports/           # Historical reports
    ├── 2025-01-09_143022/
    │   ├── hugo-build.log
    │   ├── css-validation.log
    │   ├── html-validation.log
    │   ├── playwright.log
    │   └── playwright-results.json
    └── 2025-01-09_152847/
        └── ...
```

1. **Main report** - `VALIDATION-REPORT.md` (configurable via `reportFilename`)
   - Human-readable markdown summary
   - Updated on each validation run

2. **Timestamped reports** - `.validation-reports/YYYY-MM-DD_HHMMSS/`
   - Individual logs for each stage
   - Playwright results JSON
   - Kept for debugging (configurable retention via `reportRetention`)

### Extending Linting Configs

The init command creates configs that extend the package base. Add your own overrides:

**.stylelintrc.json:**
```json
{
  "extends": ["hugo-validator/configs/stylelint"],
  "rules": {
    "selector-max-specificity": null
  }
}
```

**.htmlvalidate.json:**
```json
{
  "extends": ["hugo-validator/configs/htmlvalidate"],
  "rules": {
    "no-inline-style": "off"
  }
}
```

### NPM Scripts

After init, these scripts are available:

```bash
npm run validate         # Full validation
npm run validate:hugo    # Hugo build only
npm run validate:css     # CSS only
npm run validate:html    # HTML only
npm test                 # Playwright tests
npm run test:links       # Link tests only
npm run test:a11y        # Accessibility tests only
npm run test:ui          # Playwright UI mode
```

### Pre-commit Hook

The generated hook is minimal:

```bash
#!/bin/sh
npx hugo-validator validate
exit $?
```

All logic lives in the npm package, making updates seamless.

---

## Versioning and Updates

### How Versions Work

This package uses **GitHub releases** for versioning. Each release is tagged (e.g., `v1.0.0`, `v1.1.0`).

### Installing a Specific Version

Run these commands **from your Hugo site directory**:

```bash
# Install latest (from main branch)
npm install --save-dev github:thedavecarroll/hugo-validator

# Install a specific version (recommended for stability)
npm install --save-dev github:thedavecarroll/hugo-validator#v1.0.0

# Install from a specific branch
npm install --save-dev github:thedavecarroll/hugo-validator#develop
```

### Updating to a New Version

```bash
# Update to latest on main branch
npm update hugo-validator

# Update to a specific new version
npm install --save-dev github:thedavecarroll/hugo-validator#v1.2.0
```

### What's Preserved on Update

- `hugo-validator.config.js` - Your site-specific settings
- `.stylelintrc.json` - Your custom linting rules
- `.htmlvalidate.json` - Your custom HTML validation rules
- `tests/*.spec.ts` - Any modifications you've made to test files

### What's Updated

- The validation logic in `node_modules/hugo-validator/`
- The pre-commit hook delegates to the package, so you get new features automatically

### Checking Your Current Version

```bash
npm list hugo-validator
```

---

## Troubleshooting

### "Command not found: hugo"

Ensure Hugo is installed and in your PATH:
```bash
hugo version
```

### Tests fail with "Connection refused"

The test server may not have started. Check:
- Python 3 is installed
- Port 3000 is available
- The `public/` directory exists (run `hugo` first)

### CSS validation finds no files

Check your `cssPattern` in the config matches your theme structure:
```javascript
cssPattern: 'themes/*/assets/scss/**/*.scss'
```

### Hooks not running

Verify git is configured to use `.githooks`:
```bash
git config --get core.hooksPath
# Should output: .githooks
```

If not, run:
```bash
npx hugo-validator setup-hooks
```

---

## License

MIT
