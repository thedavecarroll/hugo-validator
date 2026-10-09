# Changelog

Versions follow [semantic versioning](https://semver.org/). Sites that install with
`github:thedavecarroll/hugo-validator#semver:^2.0.0` receive every 2.x release through `npm update hugo-validator`.

## 2.2.1

### Changed

- Dependency updates (Dependabot PR #10): html-validate 11.16.0 to 11.16.1, stylelint 17.15.0 to 17.16.0, sass-embedded 1.105.0 to 1.105.1, @types/node 24.13.6 to 24.19.1. No change in behaviour; a release so sites pick them up.
- source-map-js 1.2.1 to 1.2.2 (GHSA-68fv-2mgg-jv7q, event-loop denial of service through crafted source maps; reached through stylelint's CSS parser).
- The `braces` advisory (GHSA-vfj7-8cjw-p6xm, via stylelint and micromatch) remains open upstream. The maintainer disputes it, and no fixed version exists. It needs a pattern of thousands of characters from an untrusted source; the only patterns here come from each site's own config.

## 2.2.0

### Added

- **Image metadata scrubbing, off by default.** Photos and screenshots carry GPS coordinates, device names, timestamps and embedded thumbnails, and nothing removed them before publishing. With `images: { scrubMetadata: true }`:
  - a commit strips the metadata from each staged JPEG, PNG or WebP image, re-stages it and lists what was removed;
  - any other `validate` run fails when an image of the site carries metadata, and rewrites nothing.
- **New command `scrub-images`** cleans every image of the site; `--check` only reports. Use it once before switching the setting on.
- The picture data is never re-encoded. The colour profile is kept, and so is the orientation, so rotated photos stay upright. Formats are recognised by content, not by file name.
- A staged HEIC, AVIF or TIFF image blocks the commit, because it cannot be cleaned here; so does an image that carries metadata and is only partly staged. `images.exclude` exempts paths.
- No new dependency, and the pre-commit hook does not need regenerating. Nothing changes for a site that does not add the section.

## 2.1.0

### Added

- **Heading checks, off by default.** A page with no `<h1>`, or with several, passes WCAG 2.2 AA, so validation never flagged it. The new `headings` config section adds three opt-in checks to the accessibility suite:
  - `requireH1: true` fails a page with no `<h1>` (axe `page-has-heading-one`).
  - `allowMultipleH1: false` fails a page with more than one `<h1>` (reported as `multiple-h1`).
  - `allowSkippedLevels: false` fails a heading that skips a level (axe `heading-order`).
- Pages in `skipPaths` are exempt. Nothing changes for a site that does not add the section.

## 2.0.1

### Security

- **The generated pre-commit hook no longer uses npx.** hugo-validator is distributed from GitHub only, so the name `hugo-validator` on the npm registry is not ours. The old hook went through npx, unattended. On a fresh clone, before `npm ci`, that would have asked the registry for a package of that name. The hook now runs `node_modules/.bin/hugo-validator` directly, and blocks the commit with "Run: npm ci" when it is missing.
- **Action for existing sites:** regenerate the hook once with `npx --no hugo-validator setup-hooks --force`. `doctor` warns until you do.
- Docs, printed hints and CI now say `npx --no hugo-validator ...` and `npx --no playwright ...`. `--no` makes npx run the local copy or stop. A unit test fails if bare npx wording comes back.

### Internal

- `@types/node` stays on the major of the oldest supported Node. Dependabot ignores its major bumps, and a unit test fails if the installed types and `engines.node` disagree.
- `docs/RELEASING.md` explains which changes need a release and which do not.

## 2.0.0

The first release since 1.0.0. All validation logic now lives in the package, and a site commits configuration only.

### Breaking changes

- **Node 24.8.0 or newer is required.**
- **The tools are dependencies of the package**, not peer dependencies. Remove `@playwright/test`, `@axe-core/playwright`, `html-validate`, `stylelint` and `stylelint-config-standard-scss` from your site's `package.json`.
- **Tests are no longer copied into the site.** They are synced from the package into `hugo-validator/.runtime/` (gitignored) on every run, together with a generated Playwright config. `update-tests` is gone. Run `npx --no hugo-validator migrate` to remove old copies.
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
