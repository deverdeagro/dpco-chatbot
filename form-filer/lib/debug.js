'use strict';

const fs = require('fs');
const path = require('path');

const DEBUG_DIR = path.join(__dirname, '..', 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR);

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function snapshot(page, frame, label) {
  const stamp = ts();
  const base = `${stamp}-${label}`.replace(/\s+/g, '_');
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${base}.png`), fullPage: false });
  } catch (_) {}
  try {
    const html = await frame.evaluate(() => document.body.innerHTML);
    fs.writeFileSync(path.join(DEBUG_DIR, `${base}.html`), html);
  } catch (_) {}
  console.log(`  [debug] saved ${base}.png/.html in ./debug`);
  return base;
}

const WIDGET_SELECTORS = [
  '.ui-datepicker', '.datepicker', '.flatpickr-calendar', '.daterangepicker',
  '[class*="calendar"]:not(body)', '[class*="datepicker"]:not(body)',
];

async function findOpenWidget(frame) {
  for (const sel of WIDGET_SELECTORS) {
    try {
      const loc = frame.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible()) {
        const html = await loc.evaluate((el) => el.outerHTML);
        return { selector: sel, html };
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { snapshot, findOpenWidget, DEBUG_DIR };
