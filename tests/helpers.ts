// Shared helpers for the hugo-validator Playwright tests.
// Keep this file free of Playwright imports and TypeScript-only runtime
// syntax (enums, namespaces): the package's unit tests load it with plain Node.
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import * as os from 'os';

export interface ValidatorConfig {
  siteUrl: string;
  skipExternalDomains: Record<string, string>;
  skipPaths: string[];
  accessibility: {
    shards: number;
  };
  links: {
    failOnExternal: boolean;
    ignoreHTTPSErrors: boolean;
  };
  responsive: {
    wrapperSelector: string;
    spotCheckPages: string[];
    failOnWrapperOverflow: boolean;
  };
  interaction: {
    navSelector: string;
    touchTargetSelectors: string[];
    minTouchTarget: number;
    failOnTouchTargets: boolean;
  };
}

// Default domains to skip - these commonly block automated requests
export const DEFAULT_SKIP_DOMAINS: Record<string, string> = {
  'linkedin.com': 'Blocks automated requests (999)',
  'stackoverflow.com': 'Blocks automated requests (403)',
  'stackexchange.com': 'Blocks automated requests (403)',
  'quora.com': 'Blocks automated requests (403)',
  '4sysops.com': 'Blocks automated requests (403)',
  'docs.midjourney.com': 'Blocks automated requests (403)',
  'jigsaw.w3.org': 'Requires referrer header (403)',
};

export function getDefaults(): ValidatorConfig {
  return {
    siteUrl: 'https://example.com',
    skipExternalDomains: { ...DEFAULT_SKIP_DOMAINS },
    skipPaths: ['/rss.xml', '/sitemap.xml', '/robots.txt'],
    accessibility: {
      shards: 0, // parallel accessibility tests. 0 = automatic (about 40% of CPU cores)
    },
    links: {
      failOnExternal: false, // external sites break for reasons you do not control
      ignoreHTTPSErrors: false,
    },
    responsive: {
      wrapperSelector: '.page-wrapper',
      spotCheckPages: ['/', '/posts/', '/about/'],
      failOnWrapperOverflow: true,
    },
    interaction: {
      navSelector: '.site-nav a',
      touchTargetSelectors: [
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        'nav a',
        '.footer-icons a',
      ],
      minTouchTarget: 24, // WCAG 2.2 AA (2.5.8). Use 44 for AAA (2.5.5).
      failOnTouchTargets: true,
    },
  };
}

/** Deep merge plain objects. Arrays and scalars from source replace the target's. */
export function deepMerge<T>(target: T, source: any): T {
  const result: any = { ...(target as any) };
  for (const key of Object.keys(source || {})) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] || {}, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Load hugo-validator/hugo-validator.config.js from the project root.
 * User skipExternalDomains are added to the defaults (deep merge).
 */
export function loadConfig(projectRoot: string = process.cwd()): ValidatorConfig {
  const configPath = path.join(projectRoot, 'hugo-validator', 'hugo-validator.config.js');
  const defaults = getDefaults();
  if (!fs.existsSync(configPath)) return defaults;

  try {
    const requireFromProject = createRequire(configPath);
    return deepMerge(defaults, requireFromProject(configPath));
  } catch (error) {
    console.warn(`Warning: could not load ${configPath}: ${error instanceof Error ? error.message : error}`);
    return defaults;
  }
}

/**
 * The skip-list entry that covers a hostname, or undefined.
 * Matches the domain itself and its subdomains only: 't.co' covers
 * 'www.t.co' but not 'microsoft.com'.
 */
export function findSkipDomain(hostname: string, skipDomains: Record<string, string>): string | undefined {
  const host = hostname.toLowerCase();
  return Object.keys(skipDomains).find(entry => {
    const domain = entry.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** Playwright test status -> the three states the reports understand */
export function normalizeStatus(status: string): 'passed' | 'failed' | 'skipped' {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  return 'failed'; // failed, timedOut, interrupted, anything unknown
}

const REDIRECT_PAGE = /http-equiv=["']?refresh/i;

/**
 * Every HTML page Hugo generated, as URL paths ('/', '/posts/x/', '/404.html').
 * Read from disk, so orphan pages are included and no crawl is needed.
 * Hugo alias pages (meta refresh redirects) are left out.
 */
export function listSitePages(publicDir: string = path.join(process.cwd(), 'public')): string[] {
  const pages: string[] = [];

  function walk(directory: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        const head = readHead(entryPath);
        if (REDIRECT_PAGE.test(head)) continue;

        const relative = path.relative(publicDir, entryPath).split(path.sep).join('/');
        if (relative === 'index.html') pages.push('/');
        else if (relative.endsWith('/index.html')) pages.push(`/${relative.slice(0, -'index.html'.length)}`);
        else pages.push(`/${relative}`);
      }
    }
  }

  walk(publicDir);
  return pages.sort();
}

function readHead(filePath: string, bytes = 1024): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, 0);
      return buffer.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Pages to test: everything on disk minus config.skipPaths */
export function getAllPages(config: ValidatorConfig, publicDir?: string): string[] {
  return listSitePages(publicDir).filter(page => !config.skipPaths.some(skip => page.endsWith(skip)));
}

export type ClassifiedLink =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; url: string }
  | null;

/**
 * Classify an href found on a page.
 * - relative and root-relative links resolve against the current page
 * - absolute links to config.siteUrl are internal: they are checked against
 *   the local build, not against production
 * - returns null for anchors, mailto:, tel:, javascript:, data: and junk
 */
export function classifyLink(href: string, currentUrl: string, siteUrl: string): ClassifiedLink {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  let resolved: URL;
  let current: URL;
  try {
    current = new URL(currentUrl);
    // Protocol-relative links are external assets: check them over https
    resolved = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed, current);
  } catch {
    return null;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;

  let siteHost = '';
  try {
    siteHost = new URL(siteUrl).host.toLowerCase();
  } catch {
    // siteUrl missing or invalid: only same-origin links are internal
  }

  const host = resolved.host.toLowerCase();
  if (host === current.host.toLowerCase() || (siteHost && host === siteHost)) {
    return { kind: 'internal', path: `${resolved.pathname}${resolved.search}` };
  }

  resolved.hash = '';
  return { kind: 'external', url: resolved.toString() };
}

/** Lines with this prefix are shown live by the reporter and kept out of results.json */
export const PROGRESS_PREFIX = '⏳';

/** Log 'label: done/total' every `every` items and at the end */
export function logProgress(label: string, done: number, total: number, every = 25): void {
  if (done === total || done % every === 0) {
    console.log(`${PROGRESS_PREFIX} ${label}: ${done}/${total}`);
  }
}

/** Number of accessibility shards: the configured value, or a share of the CPU cores */
export function resolveShardCount(configured: number, cpuCount: number = os.cpus().length): number {
  if (configured > 0) return Math.floor(configured);
  return Math.max(2, Math.round(cpuCount * 0.4));
}

/** Split items round-robin into at most `count` non-empty groups of similar size */
export function shard<T>(items: T[], count: number): T[][] {
  const groups = Math.max(1, Math.min(Math.floor(count) || 1, items.length || 1));
  const result: T[][] = Array.from({ length: groups }, () => []);
  items.forEach((item, index) => result[index % groups].push(item));
  return result;
}

/** python3 -m http.server answers 200 with a listing for folders without index.html */
export function isDirectoryListing(body: string): boolean {
  return /<title>Directory listing for /i.test(body);
}
