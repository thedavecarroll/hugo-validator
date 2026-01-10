# hugo-validator Documentation

Detailed documentation for hugo-validator. For quick start, see [README.md](README.md).

---

## Configuration

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

  // HTML validation settings
  htmlValidation: {
    exclude: [
      '**/page/*/index.html', // Hugo pagination redirect pages
    ],
  },

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
  generateReport: true,  // Set to false to disable VALIDATION-REPORT.md
  reportRetention: 8,
  reportFilename: 'VALIDATION-REPORT.md',
  reportsDir: '.validation-reports',

  // Test server
  testServerPort: 3000,
};
```

---

## CLI Commands

### `npx hugo-validator init`

Initialize hugo-validator in your project:

```bash
npx hugo-validator init          # Normal setup (skips existing files)
npx hugo-validator init --force  # Overwrite existing files
npx hugo-validator init --skip-hooks  # Skip git hooks setup
```

### `npx hugo-validator validate`

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

### `npx hugo-validator setup-hooks`

Reinstall git hooks (useful if they get removed):

```bash
npx hugo-validator setup-hooks
npx hugo-validator setup-hooks --force  # Overwrite existing hook
```

---

## Validation Pipeline

The pipeline runs these stages in order:

1. **Kill dev servers** - Stops Hugo (1313), test server (3000), and any custom ports
2. **Hugo build** - Runs `hugo --panicOnWarning` to catch warnings as errors
3. **CSS validation** - Runs stylelint on your SCSS/CSS files
4. **HTML validation** - Runs html-validate on generated HTML
5. **Playwright tests** - Runs link, accessibility, responsive, and interaction tests

If any stage fails, the commit is blocked (when run as pre-commit hook).

---

## Test Suites

### Link Validation (`links.spec.ts`)

- Crawls all internal pages starting from `/`
- Validates all internal links return HTTP 200
- Checks all external links are reachable (2xx/3xx)
- Configurable skip domains for problematic external sites

### Accessibility (`a11y.spec.ts`)

- Tests all pages for WCAG 2.2 AA compliance
- Uses axe-core for comprehensive accessibility checking
- Includes WCAG 2.0, 2.1, and 2.2 rules
- Reports violations with impact level and affected elements

### Responsive (`responsive.spec.ts`)

- Tests for horizontal overflow on mobile (iPhone 12 viewport)
- Tests for horizontal overflow on tablet (iPad Mini viewport)
- Spot-checks key pages for content staying within wrapper

### Interaction (`interaction.spec.ts`)

- Tests touch targets meet 44px minimum (WCAG 2.2)
- Verifies focus indicators are visible
- Tests keyboard navigation (Tab key traversal)

---

## Reports

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
   - Set `generateReport: false` in config to disable

2. **Timestamped reports** - `.validation-reports/YYYY-MM-DD_HHMMSS/`
   - Individual logs for each stage
   - Playwright results JSON
   - Kept for debugging (configurable retention via `reportRetention`)

---

## Extending Linting Configs

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

---

## NPM Scripts

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

---

## Pre-commit Hook

The generated hook is minimal:

```bash
#!/bin/sh
npx hugo-validator validate
exit $?
```

All logic lives in the npm package, making updates seamless.
