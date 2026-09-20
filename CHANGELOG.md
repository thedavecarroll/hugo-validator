# Changelog

Versions follow [semantic versioning](https://semver.org/). Sites that install with
`github:thedavecarroll/hugo-validator#semver:^2.0.0` receive every 2.x release through `npm update hugo-validator`.

## 2.0.0

The first release since 1.0.0. All validation logic now lives in the package, and a site commits configuration only.

### Breaking changes

- **Node 24.8.0 or newer is required.**
- **The tools are dependencies of the package**, not peer dependencies. Remove `@playwright/test`, `@axe-core/playwright`, `html-validate`, `stylelint` and `stylelint-config-standard-scss` from your site's `package.json`.
- **Tests are no longer copied into the site.** They are synced from the package into `hugo-validator/.runtime/` (gitignored) on every run, together with a generated Playwright config. `update-tests` is gone. Run `npx hugo-validator migrate` to remove old copies.
- **npm scripts go through the package**: `hugo-validator validate --only <stage>` and `hugo-validator test [filter]`.
- **Broken external links are warnings** by default. Set `links.failOnExternal: true` to make them fail.
- **Minimum touch target is 24px** (WCAG 2.2 AA), was 44px. Set `interaction.minTouchTarget: 44` for AAA.
- **Pages are discovered from `public/`**, so orphan pages are tested. Use `skipPaths` to leave pages out.
- **Python is no longer used.** The test server is built in. A folder without `index.html` is a 404.
- `htmlValidation.pattern` was removed. It never had an effect.

### Added

- `doctor`: checks Node, Hugo, Sass, the tools, a real headless browser launch, config, hook and leftovers.
- `migrate`: lists, and with `--yes` removes, files left by older setups.
- `test [filter] [--ui]`: run Playwright directly.
- Smart mode that hashes every input without a file cap, and reruns only what changed.
- Live progress, per-stage time estimates from the last run, sharded accessibility checks, configurable workers.
- `browserExecutable` / `HUGO_VALIDATOR_BROWSER` for machines where Playwright's Chromium cannot run.
- Config: `links.*`, `interaction.minTouchTarget`, `interaction.failOnTouchTargets`, `responsive.failOnWrapperOverflow`, `accessibility.shards`, `testWorkers`, `testServerCommand`.
- Headless Arch Linux guide: [docs/ARCH-SETUP.md](docs/ARCH-SETUP.md).

### Fixed

- Smart mode only hashed the first 100 files, so most edits were missed.
- Rerunning only failed tests could mark the whole suite as passed.
- The pre-commit hook ran in smart mode. It now always runs the full pipeline.
- Timed-out tests were reported as passed in the summary.
- Port cleanup could kill a browser connected to the port. Only listeners are stopped now.
- HTML validation and tests ran against a stale `public/` after a failed build.
- The internal link check aborted on the first timeout or download link.
- Skip domains matched by substring (`t.co` also skipped `microsoft.com`).
- Hugo alias and pagination redirect stubs are no longer sent to html-validate.
- html-validate could not resolve the package's base config when the tool was installed inside the package.
