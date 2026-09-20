import { test, expect, devices } from '@playwright/test';
import { loadConfig, getAllPages } from './helpers';

const config = loadConfig();

const MOBILE_VIEWPORT = devices['iPhone 12'];
const TABLET_VIEWPORT = devices['iPad Mini'];

test.describe('Responsive Layout', () => {
  test('no horizontal overflow on mobile', async ({ page, baseURL }) => {
    test.setTimeout(300000); // 5 minutes - crawling all pages takes time
    // Set mobile viewport
    await page.setViewportSize({
      width: MOBILE_VIEWPORT.viewport.width,
      height: MOBILE_VIEWPORT.viewport.height,
    });

    const allPages = getAllPages(config);
    const overflowPages: { url: string; overflow: number }[] = [];
    let checkedCount = 0;

    for (const currentPath of allPages) {
      // Skip non-HTML pages (RSS feeds, XML files, etc.)
      if (currentPath.endsWith('.xml') || currentPath.endsWith('.rss') || currentPath.endsWith('.json')) {
        continue;
      }

      const response = await page.goto(`${baseURL}${currentPath}`, { waitUntil: 'load' });

      // Skip non-HTML content types
      const contentType = response?.headers()['content-type'] || '';
      if (!contentType.includes('text/html')) {
        continue;
      }

      checkedCount++;

      // Check if any content overflows horizontally
      const overflow = await page.evaluate(() => {
        const docWidth = document.documentElement.scrollWidth;
        const viewWidth = document.documentElement.clientWidth;
        return docWidth - viewWidth;
      });

      if (overflow > 0) {
        overflowPages.push({ url: currentPath, overflow });
      }
    }

    if (overflowPages.length > 0) {
      const report = overflowPages
        .map(p => `  ${p.url} (overflow: ${p.overflow}px)`)
        .join('\n');
      expect(overflowPages, `Pages with horizontal overflow:\n${report}`).toHaveLength(0);
    }

    console.log(`Checked ${checkedCount} pages for mobile overflow (skipped non-HTML)`);
  });

  test('content stays within page wrapper on mobile', async ({ page, baseURL }) => {
    await page.setViewportSize({
      width: MOBILE_VIEWPORT.viewport.width,
      height: MOBILE_VIEWPORT.viewport.height,
    });

    // Spot check key pages from config
    const pagesToCheck = config.responsive.spotCheckPages;
    const wrapperSelector = config.responsive.wrapperSelector;
    const violations: { url: string; elements: string[] }[] = [];

    for (const currentPath of pagesToCheck) {
      await page.goto(`${baseURL}${currentPath}`, { waitUntil: 'load' });

      // Find elements that extend beyond the page wrapper
      const overflowingElements = await page.evaluate((selector: string) => {
        const wrapper = document.querySelector(selector);
        if (!wrapper) return [];

        const wrapperRect = wrapper.getBoundingClientRect();
        const elements: string[] = [];

        // Check direct children and key containers
        const checkSelectors = `${selector} > *, .post-content *, .footer-icons *, .site-nav *`;
        document.querySelectorAll(checkSelectors).forEach(el => {
          const rect = el.getBoundingClientRect();
          // Allow 2px tolerance for borders/shadows
          if (rect.width > 0 && (rect.right > wrapperRect.right + 2 || rect.left < wrapperRect.left - 2)) {
            const tag = el.tagName.toLowerCase();
            const cls = el.className ? `.${el.className.toString().split(' ')[0]}` : '';
            elements.push(`${tag}${cls}`);
          }
        });

        return [...new Set(elements)].slice(0, 10); // Limit to first 10
      }, wrapperSelector);

      if (overflowingElements.length > 0) {
        violations.push({ url: currentPath, elements: overflowingElements });
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  ${v.url}: ${v.elements.join(', ')}`)
        .join('\n');
      if (config.responsive.failOnWrapperOverflow) {
        // Fails the test. Set responsive.failOnWrapperOverflow: false to get warnings instead.
        expect(violations, `Elements extending beyond wrapper:\n${report}`).toHaveLength(0);
      } else {
        test.info().annotations.push({ type: 'warning', description: `Elements extending beyond wrapper:\n${report}` });
        console.log(`Warning - elements extending beyond wrapper:\n${report}`);
      }
    }

    console.log(`Checked ${pagesToCheck.length} pages for content bounds`);
  });

  test('no horizontal overflow on tablet', async ({ page, baseURL }) => {
    test.setTimeout(300000); // 5 minutes - crawling all pages takes time
    await page.setViewportSize({
      width: TABLET_VIEWPORT.viewport.width,
      height: TABLET_VIEWPORT.viewport.height,
    });

    const allPages = getAllPages(config);
    const overflowPages: { url: string; overflow: number }[] = [];

    for (const currentPath of allPages) {
      // Skip non-HTML pages (RSS feeds, XML files, etc.)
      if (currentPath.endsWith('.xml') || currentPath.endsWith('.rss') || currentPath.endsWith('.json')) {
        continue;
      }

      const response = await page.goto(`${baseURL}${currentPath}`, { waitUntil: 'load' });

      // Skip non-HTML content types
      const contentType = response?.headers()['content-type'] || '';
      if (!contentType.includes('text/html')) {
        continue;
      }

      const overflow = await page.evaluate(() => {
        const docWidth = document.documentElement.scrollWidth;
        const viewWidth = document.documentElement.clientWidth;
        return docWidth - viewWidth;
      });

      if (overflow > 0) {
        overflowPages.push({ url: currentPath, overflow });
      }
    }

    if (overflowPages.length > 0) {
      const report = overflowPages
        .map(p => `  ${p.url} (overflow: ${p.overflow}px)`)
        .join('\n');
      expect(overflowPages, `Tablet pages with horizontal overflow:\n${report}`).toHaveLength(0);
    }

    console.log(`Checked ${allPages.length} pages for tablet overflow (skipped non-HTML)`);
  });
});
