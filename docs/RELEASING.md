# Releasing hugo-validator

Releases are git tags on `main`. Nothing is published to the npm registry. Sites install from GitHub and follow tags.

## Day to day: dependency updates

Dependabot opens pull requests on Mondays: one grouped pull request for minor and patch updates, separate ones for majors.

1. Wait for CI. It runs the type check, the unit tests and the end-to-end tests on macOS and Linux.
2. Green: merge it. The end-to-end tests prove that each validator still catches the defect it exists to catch, not only that the pipeline still runs.
   - **One exception: a major bump of `@types/node` is not safe even when green.** The types must describe the oldest supported Node. Newer types make the type check accept code that crashes on that Node, and type definitions never run, so no test can fail. `.github/dependabot.yml` ignores these bumps and `test/engines.test.js` fails on them. If one appears anyway, close it.
3. Red: read the failing case. Common causes and where to look:
   - `engines.test.js` fails: a dependency raised its Node minimum. Raise `engines.node` in `package.json`, the `@types/node` major, the README requirements table, `docs/ARCH-SETUP.md` and the CI matrix together. That is a breaking change for sites, so it needs a major release.
   - A `detects:` case fails: a tool changed a rule name or stopped reporting something. Check the tool's changelog, then adjust `configs/` or the test's expected rule id.
   - The Hugo step fails on the weekly run: a new Hugo release deprecated something. `--panicOnWarning` turns that into a failure on purpose.

## Does this change need a release?

A version describes what a site receives when it installs the package. Sites receive only what `files` in `package.json` lists: `bin`, `lib`, `tests` and `configs`.

**No release, no tag** for changes to anything else: `.github/` (CI, Dependabot), `docs/`, `CHANGELOG.md`, `test/` (unit tests, end-to-end tests, the sample site), `tsconfig.json` and dev dependencies. A site would get an identical install before and after. The same goes for `README.md`: npm always ships it, but it changes nothing a site runs. Merge these to `main` through a pull request and leave the tags alone. `npm pack --dry-run` shows exactly what ships if you are unsure.

**Release** when `bin`, `lib`, `tests`, `configs` or the `dependencies` in `package.json` change:

- **Patch** (2.0.1): a bug fix, or dependency updates you want sites to pick up.
- **Minor** (2.1.0): a new command, a new config key, or a new check that is off by default or only warns.
- **Major** (3.0.0): anything a site must change: a raised Node minimum, a removed config key, a check that newly fails sites by default.

**Dependabot merges do not reach sites on their own.** A site on `#semver:^2.0.0` resolves against tags, not against `main`, so merged updates wait on `main` until the next tag. A workable rhythm: merge green pull requests as they arrive, and cut a patch release when the sites should pick them up.

## Cutting a release

1. Decide the version using the section above.
2. On a branch: set `version` in `package.json`, run `npm install` to update the lockfile, add a section to `CHANGELOG.md`. Open a pull request and merge it when CI is green.
3. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag v2.0.1
   git push origin v2.0.1
   ```

   The `tag-matches-version` job fails if the tag and `package.json` disagree. If it fails, delete the tag, fix the version, and tag again.

## What sites do

```bash
npm update hugo-validator
npx --no playwright install chromium   # only when Playwright was updated
npx --no hugo-validator doctor
```

A site on `#semver:^2.0.0` picks up every 2.x tag. A new major needs the site to change its range, which is the point of a major.
