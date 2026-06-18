'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const { readMrpRevRows, groupByManufacturer } = require('./lib/excel');
const { selectByTyping, selectProductByTyping } = require('./lib/chosenSelect');
const { compositionsMatch } = require('./lib/aiMatch');
const { waitForElementInFrames, findFormFrame } = require('./lib/frames');
const { snapshot, findOpenWidget } = require('./lib/debug');

const PORTAL_URL   = 'https://nppaipdms.gov.in/IMCS/hissso/logoutLogin.imcs';
const LOGIN_TIMEOUT = 5 * 60 * 1000;
const NAV_TIMEOUT   = 90 * 1000;
const EXCEL_PATH    = process.argv[2] || '/Users/avinash/Desktop/DPCO/Form 5 26-05-25.xlsx';

const flaggedRows = [];

// Signals Django that the group is done and waits for a '\n' on stdin to continue.
function waitForContinue() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function gotoWithRetry(page, url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.log(`  Nav attempt ${i + 1} failed: ${err.message}. Retrying in 2s…`);
      await page.waitForTimeout(2000);
    }
  }
}

async function goToAddForm(page) {
  const { el } = await waitForElementInFrames(page, 'a#addbtn button', NAV_TIMEOUT);
  await el.click();
  await page.waitForTimeout(1500);

  const start = Date.now();
  while (Date.now() - start < NAV_TIMEOUT) {
    const frame = await findFormFrame(page);
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error('Form frame did not appear after clicking Add');
}

function readComposition(frame) {
  return frame.evaluate(() => {
    const el = document.getElementById('composition');
    return el ? el.value.trim() : '';
  });
}

// Wait for the composition field to be populated after a product selection.
// The field is cleared before selecting, so any non-empty value is the new one.
async function waitForComposition(frame, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const val = await readComposition(frame);
    if (val) return val;
    await frame.waitForTimeout(300);
  }
  return '';
}

// The portal uses bootstrap-datepicker with jQuery noConflict — cannot type directly.
async function setEffectiveDate(frame, ddmmyyyy) {
  const [day, month, year] = ddmmyyyy.split('-').map(Number);
  if (!day || !month || !year) {
    console.log(`  [FLAG] Effective Date "${ddmmyyyy}" could not be parsed as DD-MM-YYYY`);
    return false;
  }

  await frame.click('#effectiveDate');
  await frame.waitForTimeout(300);

  const result = await frame.evaluate(({ day, month, year }) => {
    const candidateNames = Object.keys(window).filter((k) => {
      try { const v = window[k]; return v && v.fn && typeof v.fn.jquery === 'string'; }
      catch (_) { return false; }
    });
    const withDatepicker = candidateNames.find((k) => window[k].fn.datepicker);
    const diag = { candidateJQueryGlobals: candidateNames, jQueryGlobalWithDatepicker: withDatepicker || null };

    if (!withDatepicker) return { ok: false, reason: 'no jQuery global has $.fn.datepicker', diag };

    const $ = window[withDatepicker];
    const el = $('#effectiveDate');
    if (!el.data('datepicker')) {
      try { el.datepicker({ format: 'dd-mm-yyyy', autoclose: true }); }
      catch (e) { return { ok: false, reason: 'datepicker init threw: ' + e.message, diag }; }
    }
    if (!el.data('datepicker')) return { ok: false, reason: 'still no datepicker instance after init', diag };

    el.datepicker('setDate', new Date(year, month - 1, day));
    el.datepicker('hide');
    el.trigger('change');
    return { ok: true, value: document.getElementById('effectiveDate').value, diag };
  }, { day, month, year });

  await frame.page().keyboard.press('Escape').catch(() => {});

  if (!result.ok) {
    console.log(`  [FLAG] Effective Date: ${result.reason}`);
    return false;
  }
  console.log(`  Effective Date → "${result.value}"`);
  return true;
}

async function fillProductRow(frame, row) {
  // Clear composition first so the value we read afterward is unambiguously the
  // newly selected product's (not the previous row's, which lingers until AJAX).
  await frame.evaluate(() => {
    const el = document.getElementById('composition');
    if (el) el.value = '';
  });

  // Type the brand stem, collect candidates, pick by strength (LLM breaks ties)
  const sel = await selectProductByTyping(frame, 'productId', row, 'Product');
  if (!sel.ok) {
    flaggedRows.push({ ...row, reason: 'Product not found by typing' });
    return false;
  }
  console.log(`  Product → "${sel.chosenLabel}" [${sel.how}]`);

  // Wait for AJAX to repopulate the (now-cleared) composition field
  const portalComposition = await waitForComposition(frame);
  if (!portalComposition) {
    console.log(`  [WARN] Composition did not auto-fill for: ${row.brandName}`);
  }

  // Verify the auto-filled composition matches the Excel composition by strength.
  // A mismatch means we selected the wrong variant — flag it, never fill it.
  const verdict = compositionsMatch(row.composition, portalComposition);
  if (verdict === false) {
    console.log(`  [FLAG] Composition mismatch for ${row.brandName}`);
    console.log(`         Excel : ${row.composition}`);
    console.log(`         Portal: ${portalComposition}`);
    flaggedRows.push({ ...row, reason: `Composition mismatch — portal selected: "${sel.chosenLabel}"` });
    return false;
  }
  if (verdict === null) {
    console.log(`  [WARN] Could not verify composition by strength for ${row.brandName} (proceeding)`);
  }

  // #pts = PTD (not a typo — that's the portal's DOM id)
  await frame.fill('#pts', String(row.ptd ?? ''));
  await frame.fill('#ptr', String(row.ptr ?? ''));
  await frame.fill('#prevRevMrp', String(row.prevMrp ?? ''));
  await frame.fill('#mrp', String(row.mrp ?? ''));
  await frame.fill('#gst', String(Math.round(Number(row.gstPct) * 100)));
  await frame.fill('#effectiveBatchNo', String(row.batchNo).toUpperCase());

  await setEffectiveDate(frame, row.effectiveDate);
  return true;
}

// Every product committed to the grid carries a hidden productHiddenDtls input,
// in either table (#Tbl1 scheduled / #Tbl2 non-scheduled). Counting these is the
// ground truth for "was the product actually added".
function countProductRows(frame) {
  return frame.evaluate(() => document.querySelectorAll('input[name="productHiddenDtls"]').length);
}

// Clicks "Add Product" and verifies a row was actually appended. The portal
// silently no-ops the Add when the product wasn't fully accepted (e.g. its
// composition never loaded), so we trust the grid row count, not the click.
async function clickAddProduct(page, frame, row) {
  // Dismiss any open datepicker before clicking the Add button
  await page.keyboard.press('Escape').catch(() => {});

  const widget = await findOpenWidget(frame);
  if (widget) {
    await frame.locator('body').click({ position: { x: 2, y: 2 }, force: true });
  }
  await page.waitForTimeout(200);

  const before = await countProductRows(frame);

  try {
    await frame.click('#addPrd', { timeout: 8000 });
  } catch (err) {
    await snapshot(page, frame, `addPrd-fail-row${row.srNo}`);
    throw err;
  }

  // The add is AJAX and silent on failure — wait for the grid to actually grow.
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await countProductRows(frame) > before) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function processGroup(page, group, isLastGroup) {
  console.log(`\n=== Group: ${group.manufacturer} (${group.rows.length} rows) ===`);

  const frame = await goToAddForm(page);

  // Select manufacturer
  const mfgFound = await selectByTyping(frame, 'manufacturerCompanyId', group.manufacturer, 'Manufacturer');
  if (!mfgFound) {
    console.log(`  [FLAG] Manufacturer not found — skipping group: ${group.manufacturer}`);
    group.rows.forEach((r) => flaggedRows.push({ ...r, reason: 'Manufacturer not found' }));
    return;
  }

  // Marketing company: use whatever is already pre-selected in the Company Name box (#companyId)
  const companyText = await frame.evaluate(() => {
    const sel = document.getElementById('companyId');
    if (!sel) return '';
    return sel.options[sel.selectedIndex]?.text?.trim() || '';
  });
  if (companyText) {
    await selectByTyping(frame, 'marketingCompanyId', companyText, 'Marketing Company');
  } else {
    console.log('  [WARN] Company Name box is empty — skipping Marketing Company selection');
  }

  // Check "Case Flag" to reveal the product dropdown
  await frame.click('#caseFlag');
  await page.waitForTimeout(1000);
  await waitForElementInFrames(page, '#productId', NAV_TIMEOUT);

  // Fill each product row
  for (const row of group.rows) {
    console.log(`  Row ${row.srNo}: ${row.brandName}`);
    try {
      const ok = await fillProductRow(frame, row);
      if (ok) {
        const added = await clickAddProduct(page, frame, row);
        if (added) {
          console.log(`  ✓ Row ${row.srNo} added`);
        } else {
          console.log(`  [FLAG] Row ${row.srNo} (${row.brandName}): clicked Add but the portal added no row`);
          flaggedRows.push({ ...row, reason: 'Add did not register — product not accepted by portal (composition likely did not load)' });
        }
      }
    } catch (err) {
      await snapshot(page, frame, `row${row.srNo}-error`).catch(() => {});
      flaggedRows.push({ ...row, reason: err.message });
      console.log(`  [FLAG] Row ${row.srNo} failed: ${err.message}`);
    }
  }

  const addedCount = await countProductRows(frame);
  console.log(`\nGroup "${group.manufacturer}": ${addedCount} of ${group.rows.length} products added to the form. Review the browser and click Submit.`);
  console.log(`[WAITING_FOR_SUBMIT:${group.manufacturer}]`);

  if (!isLastGroup) {
    await waitForContinue();
    console.log('Continuing to next group…');
  }
}

(async () => {
  process.stdin.pause();  // start paused; resumed only when waiting for user

  console.log(`Reading Excel: ${EXCEL_PATH}`);
  const rows = readMrpRevRows(EXCEL_PATH);
  const groups = groupByManufacturer(rows);
  console.log(`Found ${rows.length} rows across ${groups.length} manufacturer group(s)`);

  // Remove stale Chrome profile locks left by a previous crashed/killed session.
  const profileDir = path.join(__dirname, '.chrome-profile');
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch (_) {}
  }

  const context = await chromium.launchPersistentContext(
    profileDir,
    {
      channel: 'chrome',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    }
  );
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] || await context.newPage();
  await gotoWithRetry(page, PORTAL_URL);

  console.log('Waiting for manual login (up to 5 minutes)…');
  await waitForElementInFrames(page, '#FORM_V', LOGIN_TIMEOUT);
  console.log('Login detected. Navigating to Form V…');

  const { el: formVLink } = await waitForElementInFrames(page, '#FORM_V', NAV_TIMEOUT);
  await formVLink.click();
  await page.waitForTimeout(2000);

  for (let i = 0; i < groups.length; i++) {
    await processGroup(page, groups[i], i === groups.length - 1);
  }

  if (flaggedRows.length > 0) {
    console.log(`\n[FLAGGED_ROWS:${JSON.stringify(flaggedRows)}]`);
    console.log(`\n${flaggedRows.length} row(s) could not be auto-processed.`);
  } else {
    console.log('\nAll rows processed successfully.');
  }

  console.log('\n[DONE] Automation complete. Browser left open for review.');
  process.exit(0);
})().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
