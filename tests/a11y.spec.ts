import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadConfig, getAllPages, shard, resolveShardCount, logProgress, headingAxeRules } from './helpers';

const config = loadConfig();

// Pages come from public/ on disk, so the list is known when tests are defined.
// Axe takes about a second per page. Splitting the list into parallel tests is
// what keeps this suite fast: one test per shard, each on its own worker.
const pages = getAllPages(config);
const shards = shard(pages, resolveShardCount(config.accessibility.shards));

test.describe('Accessibility (WCAG 2.2)', () => {
  if (pages.length === 0) {
    test('all pages pass WCAG 2.2 AA', async () => {
      expect(pages.length, 'No HTML pages found in public/ - did the Hugo build run?').toBeGreaterThan(0);
    });
    return;
  }

  shards.forEach((shardPages, index) => {
    const title = shards.length === 1
      ? 'all pages pass WCAG 2.2 AA'
      : `all pages pass WCAG 2.2 AA (part ${index + 1} of ${shards.length})`;

    test(title, async ({ page, baseURL }) => {
      test.setTimeout(600000); // 10 minutes - accessibility checks take time
      const label = shards.length === 1 ? 'Accessibility' : `Accessibility part ${index + 1}/${shards.length}`;
      const violations: { url: string; issues: any[] }[] = [];

      for (const [done, currentPath] of shardPages.entries()) {
        await page.goto(`${baseURL}${currentPath}`, { waitUntil: 'load' });

        const results = await new AxeBuilder({ page })
          .options({
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
            },
            rules: {
              'target-size': { enabled: true },
              ...headingAxeRules(config.headings),
            },
          })
          .analyze();

        const issues: any[] = [...results.violations];

        // axe has no rule for more than one <h1>, so count them here
        if (!config.headings.allowMultipleH1) {
          const h1Count = await page.locator('h1').count();
          if (h1Count > 1) {
            issues.push({
              id: 'multiple-h1',
              help: `Page has ${h1Count} <h1> elements, expected one`,
              impact: 'moderate',
              nodes: new Array(h1Count),
            });
          }
        }

        if (issues.length > 0) {
          violations.push({ url: currentPath, issues });
        }
        logProgress(label, done + 1, shardPages.length);
      }

      const report = violations
        .map(v => {
          const issues = v.issues
            .map(i => `    [${i.id}] ${i.help} (${i.impact}) - ${i.nodes.length} element(s)`)
            .join('\n');
          return `  ${v.url}\n${issues}`;
        })
        .join('\n\n');

      expect(violations, `Accessibility violations:\n${report}`).toHaveLength(0);
      console.log(`${shardPages.length} pages passed WCAG 2.2 AA`);
    });
  });
});
