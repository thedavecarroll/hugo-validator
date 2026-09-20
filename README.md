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
# Install the package (GitHub only, follows 2.x releases)
npm install --save-dev "github:thedavecarroll/hugo-validator#semver:^2.0.0"
npx playwright install chromium

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
npx hugo-validator test              # Run the Playwright tests directly
npx hugo-validator test links        # ...filtered, e.g. links or a11y
npx hugo-validator doctor            # Is this machine and site ready? Node, Hugo, browser, packages, config
npx hugo-validator migrate           # List files left by older setups (add --yes to remove them)
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
| Node.js | 24.8.0 | current | The minimum every dependency supports. A unit test enforces it |
| Hugo | 0.100.0 | 0.166+ | Extended version required for SCSS |
| Dart Sass | 1.50.0 | 1.97+ | System install required (not npm sass package) |
| OS | macOS or Linux | | No GUI needed. Port cleanup uses `lsof`, `ss` or `fuser`, whichever exists. Windows is not supported (WSL works). See [docs/ARCH-SETUP.md](docs/ARCH-SETUP.md) for a headless Arch Linux setup. |

### Version Check

```bash
node --version      # Should be v24.8.0 or higher
hugo version        # Should be 0.100.0 or higher (extended)
sass --version      # Should be 1.50.0 or higher (Dart Sass)
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

### The tools come with the package

Your site needs **one** dev dependency: `hugo-validator`. It brings Playwright, axe, html-validate, stylelint and the SCSS rule set with it, at versions that are tested together. Do not list those tools in your site's `package.json`. Listing them pins old versions, and `npx hugo-validator doctor` will tell you so.

After installing, or after any update that brings a new Playwright, download its browser once:

```bash
npx playwright install chromium
```

---

## Install and Update

hugo-validator is distributed from GitHub only. It is not on the npm registry.

### Installing

```bash
# Recommended: follow 2.x releases. npm resolves the range against the repo's version tags.
npm install --save-dev "github:thedavecarroll/hugo-validator#semver:^2.0.0"

# Or pin one exact release
npm install --save-dev github:thedavecarroll/hugo-validator#v2.0.0
```

Your `package-lock.json` records the exact commit either way, so installs stay reproducible.

### Updating

```bash
npm update hugo-validator          # newest release inside your range
npx playwright install chromium    # only needed when Playwright itself was updated
npx hugo-validator doctor
```

There is nothing else to refresh. The tests and tool versions live in the package. See [CHANGELOG.md](CHANGELOG.md) for what changed.

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
- `npx hugo-validator doctor` reports the browser launches
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

## What lives where

All validation logic lives in this package. A site commits only configuration:

```
my-hugo-site/
├── hugo-validator/
│   ├── hugo-validator.config.js   # site settings (committed)
│   ├── .stylelintrc.json          # extends the package's rules (committed)
│   ├── .htmlvalidate.json         # extends the package's rules (committed)
│   ├── .runtime/                  # tests + Playwright config, synced from the package on every run (gitignored)
│   ├── reports/                   # timestamped logs (gitignored)
│   └── .validation-cache.json     # smart-mode cache (gitignored)
└── .githooks/pre-commit           # generated, runs: npx hugo-validator validate --full
```

The tests always match the installed package version. There is nothing to refresh after an upgrade.

## Upgrading from an older setup

```bash
npx hugo-validator migrate         # lists what would be removed, changes nothing
npx hugo-validator migrate --yes   # removes it, regenerates the hook, points npm scripts at the package
npx hugo-validator doctor
```

`migrate` removes only files that are recognisably the validator's own: committed copies of the tests, old Playwright configs, duplicate root linter configs, output folders of the earlier shell pipeline, and a pre-commit hook that does not call hugo-validator. Tracked files stay recoverable from git.

Behaviour changes to know about:
- Broken external links are warnings by default. Set `links.failOnExternal: true` to make them fail validation.
- The default minimum touch target is 24px (WCAG 2.2 AA). Set `interaction.minTouchTarget: 44` for the stricter AAA size.
- Pages are discovered from `public/`, so orphan pages are tested. Use `skipPaths` to leave pages out.
- The test server is built in. Python is no longer needed. A folder without `index.html` is a 404, as on a real static host.

---

## License

MIT
