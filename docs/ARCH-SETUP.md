# Headless Arch Linux setup

Everything hugo-validator does works without a display. The browser tests run headless. The only command that needs a GUI is `hugo-validator test --ui`, which you simply do not use on this machine.

## 1. System packages

```bash
sudo pacman -S --needed git openssh nodejs npm hugo jq
```

- Arch's `hugo` package is the extended build, which SCSS needs.
- Node must be 24.8.0 or newer. Arch's `nodejs` package tracks the current release, so it qualifies. Check with `node --version`.
- Port cleanup uses `lsof`, `ss` or `fuser`, whichever exists. `ss` ships with `iproute2`, which is part of the base system, so nothing extra is required.
- Dart Sass comes from the `sass-embedded` npm package in each site, which ships Linux binaries. No system `sass` is needed.

## 2. GitHub access

```bash
ssh-keygen -t ed25519 -C "you@example.com"
cat ~/.ssh/id_ed25519.pub        # add this key at github.com, Settings, SSH and GPG keys
ssh -T git@github.com
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

## 3. Clone and install a site

Sites depend on hugo-validator through a GitHub tag, so no sibling checkout is needed.

```bash
git clone git@github.com:<you>/<site>.git
cd <site>
npm ci
```

If npm reports blocked install scripts, approve only what the site needs, then reinstall:

```bash
npm install-scripts approve esbuild workerd   # only in sites that deploy with wrangler
npm ci
```

## 4. A browser for the tests

Try Playwright's bundled Chromium first:

```bash
npx playwright install chromium
npx hugo-validator doctor
```

`npx playwright install --with-deps` does not work on Arch, because it calls `apt`. If `doctor` reports that the browser cannot launch because of missing libraries, install them:

```bash
sudo pacman -S --needed nss nspr at-spi2-core libcups libdrm mesa libxkbcommon \
  libxcomposite libxdamage libxfixes libxrandr alsa-lib pango cairo
```

If that still fails, use Arch's own Chromium. It needs no display for headless use:

```bash
sudo pacman -S --needed chromium
echo 'export HUGO_VALIDATOR_BROWSER=/usr/bin/chromium' >> ~/.bashrc
source ~/.bashrc
npx hugo-validator doctor
```

You can also set `browserExecutable: '/usr/bin/chromium'` in the site's `hugo-validator.config.js`, but the environment variable keeps the setting on this machine only.

## 5. Acceptance test

```bash
npx hugo-validator doctor            # must end with "Ready to validate"
npx hugo-validator validate --full
```

If `doctor` cannot get a browser to launch with either option, this machine cannot run the browser tests. The fallback is to run validation on another machine and use this one for editing and deploying.

## 6. Previewing while you edit

There is no local browser, so serve to your network and open the page from another device:

```bash
hugo server --bind 0.0.0.0 --baseURL "http://$(hostname -i | awk '{print $1}'):1313" --appendPort=false
```

## 7. Deploying to Cloudflare Pages without a browser

`wrangler login` needs a browser. On a headless machine use an API token instead. Create one in the Cloudflare dashboard with the permission Account, Cloudflare Pages, Edit. Then:

```bash
mkdir -p ~/.config/cloudflare
cat > ~/.config/cloudflare/pages.env <<'ENV'
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
ENV
chmod 600 ~/.config/cloudflare/pages.env
```

A site's deploy script reads that file. Never commit it.
