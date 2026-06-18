/**
 * ui-tester.js
 *
 * Agent Step 1 — Screenshot Capture
 *
 * Launches a headless Chromium browser (invisible, no window opens),
 * navigates to the built preview URL, and captures screenshots at
 * three standard viewports: desktop, tablet, and mobile.
 *
 * Returns an array of screenshot objects including the base64-encoded
 * PNG data, which is passed directly to the ui-analyzer agent.
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'mobile',  width: 375,  height: 812 },
];

/**
 * Captures screenshots of the given URL at desktop, tablet, and mobile sizes.
 *
 * @param {string} previewUrl       - Full URL to the built preview (e.g. http://localhost:3000/preview/project-xxx/)
 * @param {string} screenshotsDir   - Directory to save PNG files into
 * @returns {Promise<Array>}        - Array of { viewport, width, height, filePath, base64 }
 */
export async function captureScreenshots(previewUrl, screenshotsDir) {
  await fs.mkdir(screenshotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const screenshots = [];

  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // networkidle waits until no network traffic for 500ms — enough for React to render
      await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: 20000 });

      const filePath = path.join(screenshotsDir, `${vp.name}.png`);
      await page.screenshot({ path: filePath, fullPage: true });

      const buffer = await fs.readFile(filePath);
      screenshots.push({
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        filePath,
        base64: buffer.toString('base64'),
      });

      await page.close();
    }
  } finally {
    // Always close the browser even if a screenshot fails
    await browser.close();
  }

  return screenshots;
}
