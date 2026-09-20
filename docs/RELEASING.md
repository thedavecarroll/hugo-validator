# Releasing hugo-validator

Releases are git tags on `main`. Nothing is published to the npm registry. Sites install from GitHub and follow tags.

## Day to day: dependency updates

Dependabot opens pull requests on Mondays: one grouped pull request for minor and patch updates, separate ones for majors.

1. Wait for CI. It runs the type check, the unit tests and the end-to-end tests on macOS and Linux.
2. Green: merge it. The end-to-end tests prove that each validator still catches the defect it exists to catch, not only that the pipeline still runs.
3. Red: read the failing case. Common causes and where to look:
   - `engines.test.js` fails: a dependency raised its Node minimum. Raise `engines.node` in `package.json`, the README requirements table, `docs/ARCH-SETUP.md` and the CI matrix together.
   - A `detects:` case fails: a tool changed a rule name or stopped reporting something. Check the tool's changelog, then adjust `configs/` or the test's expected rule id.
   - The Hugo step fails on the weekly run: a new Hugo release deprecated something. `--panicOnWarning` turns that into a failure on purpose.

## Cutting a release

1. Decide the version: patch for fixes and dependency updates, minor for new features or config keys, major for anything a site must change.
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
npx playwright install chromium   # only when Playwright was updated
npx hugo-validator doctor
```

A site on `#semver:^2.0.0` picks up every 2.x tag. A new major needs the site to change its range, which is the point of a major.
