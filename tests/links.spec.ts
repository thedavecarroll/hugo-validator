import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

interface LinkResult {
  url: string;
  status: number | 'error';
  error?: string;
  foundOn: string;
}

interface Config {
  siteUrl: string;
  skipExternalDomains: Record<string, string>;
  skipPaths: string[];
}

// Load configuration
function loadConfig(): Config {
  const configPath = path.join(process.cwd(), 'hugo-validator.config.js');
  const defaults: Config = {
    siteUrl: 'https://example.com',
    skipExternalDomains: {},
    skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],
  };

  if (fs.existsSync(configPath)) {
    try {
      const userConfig = require(configPath);
      return { ...defaults, ...userConfig };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

const config = loadConfig();

const INTERNAL_TIMEOUT = 5000;
const EXTERNAL_TIMEOUT = 10000;
const CONCURRENT_EXTERNAL_CHECKS = 5;

test.describe('Link Validation', () => {
  test('all internal links return 200', async ({ page, baseURL }) => {
    const visited = new Set<string>();
    const toVisit = ['/'];
    const internalLinks: Map<string, string> = new Map(); // url -> foundOn
    const brokenLinks: LinkResult[] = [];

    // Crawl all internal pages
    while (toVisit.length > 0) {
      const path = toVisit.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);

      const response = await page.goto(`${baseURL}${path}`, { timeout: INTERNAL_TIMEOUT });

      if (!response || response.status() !== 200) {
        brokenLinks.push({
          url: path,
          status: response?.status() || 'error',
          foundOn: internalLinks.get(path) || 'start',
        });
        continue;
      }

      // Extract all links from the page
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter((href): href is string => href !== null);
      });

      for (const href of links) {
        // Skip anchors, mailto, tel, javascript
        if (href.startsWith('#') || href.startsWith('mailto:') ||
            href.startsWith('tel:') || href.startsWith('javascript:')) {
          continue;
        }

        // Internal link
        if (href.startsWith('/') && !href.startsWith('//')) {
          const cleanPath = href.split('#')[0]; // Remove anchor
          if (!visited.has(cleanPath) && !toVisit.includes(cleanPath)) {
            toVisit.push(cleanPath);
            internalLinks.set(cleanPath, path);
          }
        }
      }
    }

    // Report results
    if (brokenLinks.length > 0) {
      const report = brokenLinks
        .map(l => `  ${l.url} (status: ${l.status}) - found on: ${l.foundOn}`)
        .join('\n');
      expect(brokenLinks, `Broken internal links:\n${report}`).toHaveLength(0);
    }

    console.log(`Checked ${visited.size} internal pages`);
  });

  test('all external links are reachable', async ({ page, baseURL, request }) => {
    const visited = new Set<string>();
    const toVisit = ['/'];
    const externalLinks: Map<string, string> = new Map(); // url -> foundOn
    const skippedLinks: { url: string; reason: string }[] = [];

    // Build skip domains list from config
    const skipDomains = { ...config.skipExternalDomains };

    // Crawl all internal pages to collect external links
    while (toVisit.length > 0) {
      const currentPath = toVisit.shift()!;
      if (visited.has(currentPath)) continue;
      visited.add(currentPath);

      try {
        const response = await page.goto(`${baseURL}${currentPath}`, { timeout: INTERNAL_TIMEOUT });
        if (!response || response.status() !== 200) continue;
      } catch {
        continue;
      }

      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter((href): href is string => href !== null);
      });

      for (const href of links) {
        // Internal link - add to crawl queue
        if (href.startsWith('/') && !href.startsWith('//')) {
          const cleanPath = href.split('#')[0];
          if (!visited.has(cleanPath) && !toVisit.includes(cleanPath)) {
            toVisit.push(cleanPath);
          }
          continue;
        }

        // External link
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
          const fullUrl = href.startsWith('//') ? `https:${href}` : href;

          // Check if domain should be skipped
          try {
            const domain = new URL(fullUrl).hostname;
            const skipDomain = Object.keys(skipDomains).find(d => domain.includes(d));
            if (skipDomain) {
              if (!skippedLinks.some(s => s.url === fullUrl)) {
                skippedLinks.push({ url: fullUrl, reason: skipDomains[skipDomain] });
              }
              continue;
            }
          } catch {
            continue; // Invalid URL
          }

          if (!externalLinks.has(fullUrl)) {
            externalLinks.set(fullUrl, currentPath);
          }
        }
      }
    }

    // Log skipped links
    if (skippedLinks.length > 0) {
      console.log(`Skipped ${skippedLinks.length} external links:`);
      for (const { url, reason } of skippedLinks) {
        console.log(`  - ${url} (${reason})`);
      }
    }

    console.log(`Found ${externalLinks.size} external links to check`);

    // Check external links in batches
    const results: LinkResult[] = [];
    const entries = Array.from(externalLinks.entries());

    for (let i = 0; i < entries.length; i += CONCURRENT_EXTERNAL_CHECKS) {
      const batch = entries.slice(i, i + CONCURRENT_EXTERNAL_CHECKS);
      const batchResults = await Promise.all(
        batch.map(async ([url, foundOn]) => {
          try {
            const response = await request.head(url, {
              timeout: EXTERNAL_TIMEOUT,
              ignoreHTTPSErrors: true,
            });

            // Some servers don't support HEAD, try GET
            if (response.status() === 405) {
              const getResponse = await request.get(url, {
                timeout: EXTERNAL_TIMEOUT,
                ignoreHTTPSErrors: true,
              });
              return { url, status: getResponse.status(), foundOn };
            }

            return { url, status: response.status(), foundOn };
          } catch (error) {
            return {
              url,
              status: 'error' as const,
              error: error instanceof Error ? error.message : 'Unknown error',
              foundOn,
            };
          }
        })
      );
      results.push(...batchResults);
    }

    // Filter broken links (allow redirects, but not 4xx/5xx)
    const brokenLinks = results.filter(r => {
      if (r.status === 'error') return true;
      if (typeof r.status === 'number' && r.status >= 400) return true;
      return false;
    });

    if (brokenLinks.length > 0) {
      const report = brokenLinks
        .map(l => `  ${l.url} (status: ${l.status}${l.error ? `, error: ${l.error}` : ''}) - found on: ${l.foundOn}`)
        .join('\n');

      // Use soft assertion to report all broken links but not fail immediately
      expect.soft(brokenLinks, `Broken external links:\n${report}`).toHaveLength(0);
    }

    console.log(`Checked ${results.length} external links, ${brokenLinks.length} broken`);
  });
});
