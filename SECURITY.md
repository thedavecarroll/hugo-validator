# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.x | Yes |
| 1.x | No |

Fixes land in the newest 2.x release. Sites that install with `#semver:^2.0.0` receive them through `npm update hugo-validator`.

## Reporting a vulnerability

Please report it privately: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and the version you used. You can expect a first reply within a week.

## Distribution: GitHub only

hugo-validator is distributed from this GitHub repository only. It is **not published to the npm registry**.

- Install it from GitHub, as the README shows: `github:thedavecarroll/hugo-validator#semver:^2.0.0`.
- A package named `hugo-validator` on the npm registry, if one exists, is not this project and is not maintained here. Do not install it.
- Use `npx --no hugo-validator ...`, never plain `npx hugo-validator ...`. Without a local install, plain npx asks the npm registry for that name. `--no` makes npx run your local copy or stop. The generated pre-commit hook does not use npx at all.

## What the tool does on your machine

So you can judge a report or an update:

- It runs Hugo, stylelint, html-validate and Playwright from your project's `node_modules`, launched directly with Node.
- It stops processes that are **listening** on the ports in `portsToKill` (default 1313 and 3000) before a run. Use `--no-kill` to skip that.
- It serves `public/` on `127.0.0.1` only, for the duration of the tests.
- The link test sends HEAD and GET requests to the external URLs found in your site. Nothing else leaves your machine.
