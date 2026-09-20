# hugo-validator Documentation

Detailed documentation for hugo-validator. For quick start, see [README.md](README.md).

---

## Configuration

All settings are in `hugo-validator.config.js`:

```javascript
module.exports = {
  // Required: Your site's production URL. Absolute links to it are treated as
  // internal and checked against the local build, not against production.
  siteUrl: 'https://example.com',

  // Ports to free before validation. Only processes LISTENING on the port are stopped.
  portsToKill: [1313, 3000],

  // External domains to skip in link checking
  skipExternalDomains: {
    'challenges.cloudflare.com': 'Cloudflare Turnstile widget',
    'web.archive.org': 'Archive.org rate-limits automated requests',
  },

  // CSS validation glob pattern
  cssPattern: 'themes/*/assets/scss/**/*.scss',

  // HTML validation: every public/**/*.html file is validated, minus these globs
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
    failOnWrapperOverflow: true, // false = report as warnings
  },

  // Accessibility testing: pages are split into parallel tests
  accessibility: {
    shards: 0, // 0 = automatic (about 40% of CPU cores). Set a number to override
  },

  // Link testing
  links: {
    failOnExternal: false,    // Broken external links are warnings. true = they fail validation
    ignoreHTTPSErrors: false, // true = accept expired or self-signed certificates
  },

  // Interaction testing
  interaction: {
    navSelector: '.site-nav a',
    touchTargetSelectors: ['button', 'input', 'nav a'],
    minTouchTarget: 24,       // px. 24 = WCAG 2.2 AA (2.5.8), 44 = AAA (2.5.5)
    failOnTouchTargets: true, // false = report as warnings
  },

  // Report settings
  generateReport: true,  // Set to false to disable VALIDATION-REPORT.md
  reportRetention: 8,
  reportFilename: 'VALIDATION-REPORT.md',
  reportsDir: 'hugo-validator/reports',

  // Parallel Playwright workers: a number or a percentage of CPU cores.
  // null = Playwright's default (50%). Ignored when the CI environment variable is set.
  testWorkers: '80%',

  // Test server: the built-in Node server serves public/ on this port
  testServerPort: 3000,
  testServerCommand: null, // null = built-in server. A custom command runs from <site>/hugo-validator

  // Browser for the tests. null = Playwright's bundled Chromium.
  // Set a path (or env HUGO_VALIDATOR_BROWSER) to use a system browser, e.g. on Arch Linux
  browserExecutable: null,
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
npx hugo-validator validate              # Run all stages (smart mode)
npx hugo-validator validate --full       # Run every stage, ignore the cache
npx hugo-validator validate --only hugo  # Hugo build only
npx hugo-validator validate --only css   # CSS validation only
npx hugo-validator validate --only html  # HTML validation only
npx hugo-validator validate --only tests # Playwright tests only
npx hugo-validator validate --no-kill    # Don't kill dev servers
npx hugo-validator validate --no-report  # Skip report generation
```

### `npx hugo-validator test`

Run the Playwright tests directly, with Playwright's own output:

```bash
npx hugo-validator test           # all tests
npx hugo-validator test links     # only files matching "links"
npx hugo-validator test --ui      # Playwright UI mode (needs a display)
```

The site must already be built (`hugo`, or `npx hugo-validator validate --only hugo`).

### `npx hugo-validator doctor`

Checks that this machine and site can run validation: Node version, Hugo extended, Dart Sass, a port tool, package versions against the supported ranges, that a headless browser really launches, config sanity, the git hook, and leftover legacy files. Exits non-zero when something blocks validation. Run it first on a new machine.

### `npx hugo-validator migrate`

Lists files left behind by older setups. With `--yes` it removes them, regenerates the pre-commit hook and points the npm scripts at the package. Without `--yes` nothing changes.

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
If the Hugo build fails, HTML validation and the tests are skipped, because `public/` would be stale.
The build uses `--cleanDestinationDir`, so pages you deleted are removed from `public/`.

### Smart mode

`validate` without `--full` skips a stage when it passed last time and none of its inputs changed.
Inputs are hashed in full, with no file limit:

| Stage | Inputs |
|-------|--------|
| hugo | Hugo config files, `config/`, `content/`, `layouts/`, `themes/`, `data/`, `assets/`, `static/`, `i18n/`, `archetypes/`, the validator config |
| css | files matching `cssPattern`, `.stylelintrc.json` |
| html | `public/**/*.html`, `.htmlvalidate.json`, the validator config |
| tests | `public/`, the package's own tests, the validator config |

The package version is part of every digest, so upgrading hugo-validator re-runs every stage once.

After a test failure, only the failed tests rerun, and only while the inputs are identical to the failing run.
That shortcut is recorded as `partial`, so one complete test run always follows before the stage can be skipped.
Any input change triggers a complete test run.

The pre-commit hook always runs with `--full`.

### Speed and progress

- Before a stage that took 5 seconds or more last time, the runner prints how long it took, for example `⏳ tests: last run took 1m 8s`.
- While the tests run, each finished test is printed with a counter, and long tests print progress such as `⏳ Accessibility part 2/4: 25/44`.
- Accessibility checking costs about a second per page and is CPU-bound. The pages are split into `accessibility.shards` parallel tests, and the runner uses `testWorkers` workers.
- More shards than about 40% of your cores makes the run slower, because the CPU saturates.

---

## Test Suites

### Link Validation (`links.spec.ts`)

- Reads every generated page from `public/`, so orphan pages are included (Hugo alias redirects are left out)
- Validates all internal links return HTTP 200, including relative links and downloads such as PDFs
- Treats absolute links to `siteUrl` as internal
- Flags links to folders without an `index.html`
- Checks all external links are reachable (2xx/3xx)
- Configurable skip domains for problematic external sites. An entry covers the domain and its subdomains only
- Broken external links are **warnings** by default: they are listed in the console and the report but do not fail validation. Set `links.failOnExternal: true` to make them fail
- A timeout or dropped connection is retried once before the link is reported. Certificate errors are reported immediately (`links.ignoreHTTPSErrors: true` accepts them)

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

- Tests touch targets meet `interaction.minTouchTarget` (default 24px, WCAG 2.2 AA. Use 44 for AAA)
- Ignores hidden inputs and screen-reader-only elements clipped to 1px, which are not pointer targets
- Verifies focus indicators are visible (outline or box-shadow)
- Tests keyboard navigation (Tab key traversal)

---

## Reports

Validation generates reports **in your Hugo site directory**:

```
my-hugo-blog/
├── VALIDATION-REPORT.md           # Main report (updated each run)
└── hugo-validator/                # Updated path for historical reports
  └── reports/                   # Historical reports
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

2. **Timestamped reports** - `hugo-validator/reports/YYYY-MM-DD_HHMMSS/`
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
npx hugo-validator validate --full
exit $?
```

The hook always runs the complete pipeline. Cached results never gate a commit.
If `core.hooksPath` is already set by another tool, `setup-hooks` leaves it unchanged unless you pass `--force`.

All logic lives in the package, including the tests. On every run they are synced into `hugo-validator/.runtime/`, which is gitignored, together with a generated Playwright config. Sites commit configuration only.
