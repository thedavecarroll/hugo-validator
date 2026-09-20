import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { loadConfig, getAllPages, classifyLink, findSkipDomain, isDirectoryListing, logProgress } from './helpers';

interface LinkResult {
  url: string;
  status: number | 'error' | 'skipped';
  error?: string;
  foundOn: string;
}

const config = loadConfig();

const INTERNAL_TIMEOUT = 10000;
const EXTERNAL_TIMEOUT = 10000;
const CONCURRENT_EXTERNAL_CHECKS = 10;

/** All hrefs on a page. Throws if the page cannot be loaded. */
async function collectHrefs(page: Page, url: string): Promise<string[]> {
  const response = await page.goto(url, { timeout: INTERNAL_TIMEOUT, waitUntil: 'domcontentloaded' });
  if (!response || response.status() !== 200) {
    throw new Error(`status ${response ? response.status() : 'none'}`);
  }
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter((href): href is string => href !== null)
  );
}

/**
 * Check one internal target with a plain HTTP request. Unlike page.goto this
 * works for PDFs, zips and other downloads, and never aborts the test.
 */
async function checkInternalTarget(request: APIRequestContext, baseURL: string, target: string): Promise<{ ok: boolean; status: number | 'error'; error?: string }> {
  try {
    const response = await request.get(`${baseURL}${target}`, { timeout: INTERNAL_TIMEOUT });
    const status = response.status();
    if (status !== 200) return { ok: false, status };

    const contentType = response.headers()['content-type'] || '';
    if (contentType.includes('text/html') && isDirectoryListing(await response.text())) {
      return { ok: false, status: 'error', error: 'folder has no index.html (test server returned a directory listing)' };
    }
    return { ok: true, status };
  } catch (error) {
    return { ok: false, status: 'error', error: error instanceof Error ? error.message.split('\n')[0] : 'Unknown error' };
  }
}

test.describe('Link Validation', () => {
  test('all internal links return 200', async ({ page, baseURL, request }) => {
    test.setTimeout(600000); // 10 minutes - large sites have many pages
    const pages = getAllPages(config);
    const targets: Map<string, string> = new Map(); // internal path -> first page it was found on
    const brokenLinks: LinkResult[] = [];

    expect(pages.length, 'No HTML pages found in public/ - did the Hugo build run?').toBeGreaterThan(0);

    // Every generated page is read from disk, so orphan pages are covered too
    for (const currentPath of pages) {
      const currentUrl = `${baseURL}${currentPath}`;
      let hrefs: string[];
      try {
        hrefs = await collectHrefs(page, currentUrl);
      } catch (error) {
        brokenLinks.push({
          url: currentPath,
          status: 'error',
          error: error instanceof Error ? error.message.split('\n')[0] : 'Unknown error',
          foundOn: 'public/ (generated page failed to load)',
        });
        continue;
      }

      for (const href of hrefs) {
        const link = classifyLink(href, currentUrl, config.siteUrl);
        if (link?.kind === 'internal' && !targets.has(link.path)) {
          targets.set(link.path, currentPath);
        }
      }
    }

    let checked = 0;
    for (const [target, foundOn] of targets) {
      logProgress('Internal links', ++checked, targets.size, 50);
      const result = await checkInternalTarget(request, baseURL!, target);
      if (!result.ok) {
        brokenLinks.push({ url: target, status: result.status, error: result.error, foundOn });
      }
    }

    console.log(`Checked ${targets.size} internal links across ${pages.length} pages`);

    const report = brokenLinks
      .map(l => `  ${l.url} (status: ${l.status}${l.error ? `, ${l.error}` : ''}) - found on: ${l.foundOn}`)
      .join('\n');
    expect(brokenLinks, `Broken internal links:\n${report}`).toHaveLength(0);
  });

  test('all external links are reachable', async ({ page, baseURL, request }) => {
    test.setTimeout(600000); // 10 minutes - checking many external links takes time
    const pages = getAllPages(config);
    const externalLinks: Map<string, string> = new Map(); // url -> foundOn
    const skippedLinks: Map<string, string> = new Map(); // url -> reason
    const skipDomains = config.skipExternalDomains;

    // Collect external links from every generated page
    for (const currentPath of pages) {
      const currentUrl = `${baseURL}${currentPath}`;
      let hrefs: string[];
      try {
        hrefs = await collectHrefs(page, currentUrl);
      } catch {
        continue; // Unloadable pages are reported by the internal link test
      }

      for (const href of hrefs) {
        // Links to config.siteUrl classify as internal, so an unpublished
        // post is never checked against production here
        const link = classifyLink(href, currentUrl, config.siteUrl);
        if (link?.kind !== 'external') continue;

        const skipDomain = findSkipDomain(new URL(link.url).hostname, skipDomains);
        if (skipDomain) {
          skippedLinks.set(link.url, skipDomains[skipDomain]);
        } else if (!externalLinks.has(link.url)) {
          externalLinks.set(link.url, currentPath);
        }
      }
    }

    if (skippedLinks.size > 0 && process.env.HUGO_VALIDATOR_VERBOSE === '1') {
      console.log(`Skipped ${skippedLinks.size} external links:`);
      for (const [url, reason] of skippedLinks) {
        console.log(`  - ${url} (${reason})`);
      }
    }

    console.log(`Found ${externalLinks.size} external links to check`);

    // Check external links in batches
    const results: LinkResult[] = [];
    const entries = Array.from(externalLinks.entries());
    const rateLimitedDomains = new Set<string>(); // Domains that returned 429
    const requestOptions = {
      timeout: EXTERNAL_TIMEOUT,
      ignoreHTTPSErrors: config.links.ignoreHTTPSErrors,
    };

    for (let i = 0; i < entries.length; i += CONCURRENT_EXTERNAL_CHECKS) {
      const batch = entries.slice(i, i + CONCURRENT_EXTERNAL_CHECKS);
      const batchResults = await Promise.all(
        batch.map(async ([url, foundOn]): Promise<LinkResult> => {
          const domain = new URL(url).hostname;
          if (rateLimitedDomains.has(domain)) {
            return { url, status: 'skipped', foundOn, error: 'Domain rate limited (429)' };
          }

          try {
            let status = (await request.head(url, requestOptions)).status();

            // Try GET if HEAD fails - many sites block HEAD but allow GET
            // 405 = Method Not Allowed, 403/404/429/999 = often bot blocking
            if ([405, 403, 404, 429, 999].includes(status)) {
              try {
                status = (await request.get(url, requestOptions)).status();
              } catch {
                // GET also failed, keep original HEAD status
              }
            }

            // If still 429, mark domain as rate limited for future URLs
            if (status === 429) {
              rateLimitedDomains.add(domain);
              return { url, status: 'skipped', foundOn, error: 'Rate limited (429)' };
            }

            return { url, status, foundOn };
          } catch (error) {
            const message = error instanceof Error ? error.message.split('\n')[0] : 'Unknown error';

            // Timeouts and dropped connections are often transient: retry once with GET.
            // Certificate problems are not transient, so they are reported straight away.
            if (!/certificate|altnames|self.signed/i.test(message)) {
              try {
                const retryStatus = (await request.get(url, requestOptions)).status();
                if (retryStatus === 429) {
                  rateLimitedDomains.add(domain);
                  return { url, status: 'skipped', foundOn, error: 'Rate limited (429)' };
                }
                return { url, status: retryStatus, foundOn };
              } catch {
                // Retry failed too: report the original error
              }
            }

            return { url, status: 'error', error: message, foundOn };
          }
        })
      );
      results.push(...batchResults);
      logProgress('External links', Math.min(i + CONCURRENT_EXTERNAL_CHECKS, entries.length), entries.length, 50);
    }

    if (rateLimitedDomains.size > 0) {
      console.log(`Skipped remaining URLs from rate-limited domains: ${Array.from(rateLimitedDomains).join(', ')}`);
    }

    // Redirects are fine. 4xx/5xx and network errors are broken. Rate-limited is neither.
    const brokenLinks = results.filter(r =>
      r.status === 'error' || (typeof r.status === 'number' && r.status >= 400)
    );

    console.log(`Checked ${results.length} external links, ${brokenLinks.length} broken`);

    if (brokenLinks.length > 0) {
      const report = brokenLinks
        .map(l => `  ${l.url} (status: ${l.status}${l.error ? `, error: ${l.error}` : ''}) - found on: ${l.foundOn}`)
        .join('\n');

      if (config.links.failOnExternal) {
        // Opt-in: links.failOnExternal: true makes broken external links fail validation
        expect(brokenLinks, `Broken external links:\n${report}`).toHaveLength(0);
      } else {
        // Default: external sites break for reasons the site owner does not control
        test.info().annotations.push({ type: 'warning', description: `${brokenLinks.length} broken external links:\n${report}` });
        console.log(`Warning - broken external links:\n${report}`);
      }
    }
  });
});
