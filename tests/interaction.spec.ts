import { test, expect, devices } from '@playwright/test';
import { loadConfig, getAllPages } from './helpers';

const config = loadConfig();

const MOBILE_VIEWPORT = devices['iPhone 12'];
// WCAG 2.2 AA (2.5.8) requires 24px. 44px is the AAA level (2.5.5).
const MIN_TOUCH_TARGET = config.interaction.minTouchTarget;

test.describe('Interaction', () => {
  test('touch targets meet minimum size on mobile', async ({ page, baseURL }) => {
    test.setTimeout(300000); // 5 minutes - crawling all pages takes time
    await page.setViewportSize({
      width: MOBILE_VIEWPORT.viewport.width,
      height: MOBILE_VIEWPORT.viewport.height,
    });

    const allPages = getAllPages(config);
    const violations: { url: string; elements: { selector: string; width: number; height: number }[] }[] = [];

    // Get selectors from config
    const standaloneSelectors = config.interaction.touchTargetSelectors;

    for (const currentPath of allPages) {
      await page.goto(`${baseURL}${currentPath}`, { waitUntil: 'load' });

      // Check interactive elements for minimum touch target size
      const smallTargets = await page.evaluate(
        ({ minSize, selectors }: { minSize: number; selectors: string[] }) => {
          const small: { selector: string; width: number; height: number }[] = [];

          for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);

              // Hidden inputs are never a touch target
              if (el instanceof HTMLInputElement && el.type === 'hidden') return;

              // Screen-reader-only elements (clipped to 1px) cannot be hit by a
              // pointer, so target size does not apply to them
              if (rect.width <= 1 && rect.height <= 1) return;

              // Skip hidden elements
              if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) {
                return;
              }

              // Check if either dimension is too small
              if (rect.width < minSize || rect.height < minSize) {
                const tag = el.tagName.toLowerCase();
                const cls = el.className ? `.${el.className.toString().split(' ')[0]}` : '';
                const text = el.textContent?.trim().substring(0, 20) || '';
                small.push({
                  selector: `${tag}${cls}${text ? ` "${text}"` : ''}`,
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                });
              }
            });
          }

          return small;
        },
        { minSize: MIN_TOUCH_TARGET, selectors: standaloneSelectors }
      );

      if (smallTargets.length > 0) {
        violations.push({ url: currentPath, elements: smallTargets });
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => {
          const elements = v.elements
            .map(e => `    ${e.selector} (${e.width}x${e.height}px)`)
            .join('\n');
          return `  ${v.url}\n${elements}`;
        })
        .join('\n');

      if (config.interaction.failOnTouchTargets) {
        // Fails the test. Set interaction.failOnTouchTargets: false to get warnings instead.
        expect(violations, `Touch targets smaller than ${MIN_TOUCH_TARGET}px:\n${report}`).toHaveLength(0);
      } else {
        test.info().annotations.push({ type: 'warning', description: `Touch targets smaller than ${MIN_TOUCH_TARGET}px:\n${report}` });
        console.log(`Warning - touch targets smaller than ${MIN_TOUCH_TARGET}px:\n${report}`);
      }
    }

    if (process.env.HUGO_VALIDATOR_VERBOSE === '1') {
      console.log(`Checked ${allPages.length} pages for touch target sizes`);
    }
  });

  test('focus indicators are visible', async ({ page, baseURL }) => {
    // Test focus on homepage only - spot check
    await page.goto(`${baseURL}/`, { waitUntil: 'load' });

    // Check that key navigation links have visible focus indicators
    const navSelector = config.interaction.navSelector;
    const navLinks = page.locator(navSelector);
    const count = await navLinks.count();

    let missingFocus = 0;
    for (let i = 0; i < count; i++) {
      const link = navLinks.nth(i);

      // Skip if not visible
      if (!await link.isVisible()) continue;

      // Focus and check outline
      await link.focus();

      // Give browser time to apply focus styles
      const outlineStyle = await link.evaluate(el => {
        const style = window.getComputedStyle(el);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        };
      });

      const hasOutline = outlineStyle.outlineStyle !== 'none' &&
                         outlineStyle.outlineWidth !== '0px' &&
                         outlineStyle.outlineColor !== 'transparent';
      // Many themes draw the focus ring with box-shadow instead of outline
      const hasShadow = outlineStyle.boxShadow !== '' && outlineStyle.boxShadow !== 'none';

      if (!hasOutline && !hasShadow) {
        missingFocus++;
      }
    }

    expect(missingFocus, `${missingFocus} navigation links missing focus indicators`).toBe(0);
    if (process.env.HUGO_VALIDATOR_VERBOSE === '1') {
      console.log(`Checked homepage for focus indicators`);
    }
  });

  test('keyboard navigation works', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'load' });

    // Tab through the page and ensure focus moves
    const focusedElements: string[] = [];

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');

      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const tag = el.tagName.toLowerCase();
        const href = el.getAttribute('href') || '';
        return `${tag}${href ? `[href="${href.substring(0, 30)}"]` : ''}`;
      });

      if (focused) {
        focusedElements.push(focused);
      }
    }

    expect(focusedElements.length, 'Should be able to tab through interactive elements').toBeGreaterThan(0);
    if (process.env.HUGO_VALIDATOR_VERBOSE === '1') {
      console.log(`Tabbed through ${focusedElements.length} elements: ${focusedElements.slice(0, 5).join(', ')}...`);
    }
  });
});
