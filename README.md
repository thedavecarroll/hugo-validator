# hugo-validator

Comprehensive validation pipeline for Hugo sites. Catch broken links, accessibility issues, CSS problems, and more before they hit production.

> **Note:** This project was created for my personal Hugo sites. It is provided as-is without warranty or guaranteed support. Feel free to use it, fork it, or adapt it to your needs. Issues and pull requests are welcome, but response times may vary.

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

Run these commands **from your Hugo site's root directory**:

```bash
# Install the package
npm install --save-dev github:thedavecarroll/hugo-validator

# Initialize - creates config files in your site repo
npx hugo-validator init

# Edit the config file with your site settings
nano hugo-validator/hugo-validator.config.js

# Run validation
npx hugo-validator validate
```

---

## CLI Commands

### Initialization

```bash
npx hugo-validator init              # Normal setup (skips existing files)
npx hugo-validator init --force      # Overwrite existing files
npx hugo-validator init --skip-hooks # Skip git hooks setup
```

### Validation

```bash
npx hugo-validator validate              # Run all stages (smart mode: skips unchanged, passed stages)
npx hugo-validator validate --full       # Run every stage, ignore the cache
npx hugo-validator validate --only hugo  # Hugo build only
npx hugo-validator validate --only css   # CSS validation only
npx hugo-validator validate --only html  # HTML validation only
npx hugo-validator validate --only tests # Playwright tests only
npx hugo-validator validate --no-report  # Skip report generation
```

### Other Commands

```bash
npx hugo-validator setup-hooks       # Reinstall git hooks
npx hugo-validator update-tests      # Refresh hugo-validator/tests/ after upgrading (config untouched)
npx hugo-validator clear-cache       # Clear validation cache
```

---

## Configuration

After running `init`, edit `hugo-validator/hugo-validator.config.js`:

```javascript
module.exports = {
  // Required: Your site's production URL. Links to it are checked against
  // the local build, so an unpublished post does not fail the link check.
  siteUrl: 'https://example.com',

  // External domains to skip in link checking
  skipExternalDomains: {
    'linkedin.com': 'Blocks automated requests',
    'web.archive.org': 'Rate-limits automated requests',
  },

  // CSS validation glob pattern
  cssPattern: 'themes/*/assets/scss/**/*.scss',

  // Paths to skip in tests (RSS, sitemap, etc.)
  skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],

  // Responsive testing
  responsive: {
    wrapperSelector: '.page-wrapper',   // Your main content wrapper
    spotCheckPages: ['/', '/posts/'],   // Pages to check for wrapper bounds
  },

  // Link testing
  links: {
    failOnExternal: false,              // Broken external links warn. true = they fail validation
  },

  // Interaction testing
  interaction: {
    navSelector: '.site-nav a',         // Navigation links for keyboard test
    minTouchTarget: 24,                 // px. 24 = WCAG 2.2 AA, 44 = AAA
  },

  // Report settings
  generateReport: true,
  reportsDir: 'hugo-validator/reports',
};
```

For complete configuration options, see [DOCUMENTATION.md](DOCUMENTATION.md).

---

## Requirements

| Tool | Minimum Version | Recommended | Notes |
|------|-----------------|-------------|-------|
| Node.js | 22.22.0 | 24+ | Minimum set by html-validate 11 and commander 15 |
| Hugo | 0.100.0 | 0.166+ | Extended version required for SCSS |
| Dart Sass | 1.50.0 | 1.97+ | System install required (not npm sass package) |
| Python | 3.7+ | 3.9+ | Default test server (replace with `testServerCommand`) |
| OS | macOS or Linux | | Port cleanup uses `lsof`. Windows is not supported (WSL works). |

### Version Check

```bash
node --version      # Should be v22.22.0 or higher
hugo version        # Should be 0.100.0 or higher (extended)
sass --version      # Should be 1.50.0 or higher (Dart Sass)
python3 --version   # Should be 3.7 or higher
```

### Installing Dart Sass

Hugo requires the **Dart Sass binary** (not the npm `sass` package). Install it system-wide:

**macOS (ARM64):**
```bash
curl -L -o /tmp/dart-sass.tar.gz https://github.com/sass/dart-sass/releases/download/1.97.2/dart-sass-1.97.2-macos-arm64.tar.gz
tar -xzf /tmp/dart-sass.tar.gz -C /tmp
sudo mv /tmp/dart-sass /usr/local/dart-sass
sudo ln -s /usr/local/dart-sass/sass /usr/local/bin/sass
```

**macOS (Intel):**
```bash
curl -L -o /tmp/dart-sass.tar.gz https://github.com/sass/dart-sass/releases/download/1.97.2/dart-sass-1.97.2-macos-x64.tar.gz
tar -xzf /tmp/dart-sass.tar.gz -C /tmp
sudo mv /tmp/dart-sass /usr/local/dart-sass
sudo ln -s /usr/local/dart-sass/sass /usr/local/bin/sass
```

**Why not npm sass?** The npm `sass` package conflicts with Hugo's embedded Dart Sass protocol. Using the native binary avoids PATH conflicts when running through npx.

### Peer Dependencies

Installed automatically when you run `npm install`:
- `@playwright/test` ^1.49.0
- `@axe-core/playwright` ^4.11.0
- `html-validate` ^11.16.0
- `stylelint` ^17.15.0
- `stylelint-config-standard-scss` ^17.0.0

---

## Install and Update

### Installing a Specific Version

```bash
# Install latest (from main branch)
npm install --save-dev github:thedavecarroll/hugo-validator

# Install a specific version (recommended for stability)
npm install --save-dev github:thedavecarroll/hugo-validator#v2.0.0
```

### Updating

```bash
# Update to latest on main branch
npm update hugo-validator

# Update to a specific new version
npm install --save-dev github:thedavecarroll/hugo-validator#v2.0.0
```

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
- Port 3000 is available (or set `testServerPort` in the config)
- The `public/` directory exists (run `hugo` first)

### CSS validation finds no files

Check your `cssPattern` in the config matches your theme structure:
```javascript
cssPattern: 'themes/*/assets/scss/**/*.scss'
```

### Hugo build fails with "TOCSS-DART: unexpected EOF"

Hugo is finding the wrong `sass` binary. Check:
```bash
which sass
file $(which sass)
```

If it shows a Node.js script (not a shell script), you have the npm sass package conflicting. Fix:

1. Install the Dart Sass binary (see Requirements above)
2. If `node_modules/.bin/sass` exists, remove it: `rm node_modules/.bin/sass`
3. Remove `sass-embedded` from your `package.json` if present

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

If `core.hooksPath` already points somewhere else (Husky, lefthook), `setup-hooks` leaves it alone.
Call `npx hugo-validator validate --full` from your existing pre-commit hook, or pass `--force`.

### A page fails that the tests never checked before

Pages are now discovered from `public/` on disk, not by following links, so orphan pages are tested too.
Add pages you do not want tested to `skipPaths`, for example `skipPaths: ['/rss.xml', '/easter-egg/']`.

---

## Upgrading

After updating the package in an existing project:

```bash
npx hugo-validator update-tests        # new test files, including tests/helpers.ts
npx hugo-validator setup-hooks --force # hook now runs validate --full
npx hugo-validator clear-cache
```

- `hugo-validator/playwright.config.ts` is not regenerated. To make `testServerPort` and `testServerCommand` take effect, delete it and run `npx hugo-validator init`, which recreates only missing files.
- Broken external links are now warnings by default. Set `links.failOnExternal: true` to make them fail validation again.
- The default minimum touch target changed from 44px to 24px (WCAG 2.2 AA). Set `interaction.minTouchTarget: 44` to keep the stricter AAA size.
- Add `hugo-validator/.validation-cache.json` and `VALIDATION-REPORT.md` to `.gitignore` (new projects get this from `init`).

---

## License

MIT
