'use strict';

async function findElementInFrames(page, selector) {
  const mainEl = page.locator(selector).first();
  if (await mainEl.count() > 0) return { frame: page, el: mainEl };

  for (const frame of page.frames()) {
    try {
      const el = frame.locator(selector).first();
      if (await el.count() > 0) return { frame, el };
    } catch (_) {}
  }
  return null;
}

async function waitForElementInFrames(page, selector, timeout) {
  const start = Date.now();
  const deadline = start + timeout;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const found = await findElementInFrames(page, selector);
    if (found) return found;
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed - lastLog >= 5) {
      console.log(`  ... still waiting for "${selector}" (${elapsed}s elapsed)`);
      lastLog = elapsed;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for "${selector}" across all frames`);
}

async function findFormFrame(page) {
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('#productId, #manufacturerCompanyId, #caseFlag').first().count() > 0) {
        return frame;
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { findElementInFrames, waitForElementInFrames, findFormFrame };
