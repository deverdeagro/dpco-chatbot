# DPCO Form V Portal Automation — Full Replication Plan

## Goal

Automate filing of **FORM V (MRP Revision)** on the NPPA IPDMS portal (`https://nppaipdms.gov.in/IMCS/hissso/logoutLogin.imcs`) using Node.js + Playwright. The script reads an Excel file, groups rows by manufacturer, and for each group: selects dropdowns, fills product rows one by one, and pauses before final submit so the user can review and submit manually.

---

## Project Structure

```
dpco-form-filing/
├── index.js                  # main entry point
├── package.json
├── lib/
│   ├── excel.js              # Excel parsing + row grouping
│   ├── match.js              # fuzzy string matching
│   ├── frames.js             # cross-iframe element helpers
│   ├── chosenSelect.js       # chosen.js dropdown driver
│   └── debug.js              # screenshot/HTML snapshot + widget finder
├── .chrome-profile/          # persistent Chrome profile (auto-created, add to .gitignore)
└── debug/                    # screenshots + HTML dumps on errors (auto-created)
```

---

## Setup

### `package.json`

```json
{
  "name": "dpco-form-filing",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "start": "node index.js" },
  "type": "commonjs",
  "dependencies": {
    "playwright": "^1.61.0",
    "string-similarity": "^4.0.4",
    "xlsx": "^0.18.5"
  }
}
```

After creating, run:

```bash
npm install
npx playwright install chrome
```

### Running

```bash
npm start
# or with a custom Excel file:
node index.js "/path/to/your/file.xlsx"
```

The script opens Chrome, waits up to 5 minutes for manual login, then proceeds automatically. After each manufacturer group it pauses for you to review and submit manually before moving to the next group.

---

## `lib/excel.js`

Reads sheet **"MRP Rev"** from the Excel file. Header row is at index 1 (row 2 in Excel — row 1 is a title/merge row). Uses `{ cellDates: true }` so date cells come back as JS `Date` objects.

### Column mappings

> Note: some header names have leading/trailing spaces in the actual file — trim all headers when reading.

| Row field | Excel column header |
|---|---|
| `srNo` | `Sr. No` |
| `brandName` | `Brand Name` |
| `composition` | `Drug (Composition DCA)` |
| `dosage` | `Dosage (Product Type)` |
| `size` | `Size (Unit Pack)` |
| `manufacturer` | `Manufacturer` |
| `gstPct` | `GST %` |
| `prevMrp` | ` Previous MRP` (**leading space** in header) |
| `ptd` | `PTD Without GST` |
| `ptr` | `PTR Without GST` |
| `mrp` | `Revised MRP` |
| `batchNo` | `Batch No` |
| `effectiveDate` | `Effective Date` |

### Notes

- `effectiveDate` is a JS `Date` object — convert to `DD-MM-YYYY` string.
- `gstPct` is a decimal (e.g. `0.12`) — multiply × 100 and round to get the integer to fill into the form.
- Skip rows where `brandName` is blank (footer/empty rows).
- Group rows by `manufacturer` (case-insensitive key) → return array of `{ manufacturer, rows[] }`.

### Full implementation

```javascript
const XLSX = require('xlsx');

function excelDateToDDMMYYYY(value) {
  if (value instanceof Date) {
    const d = String(value.getDate()).padStart(2, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const y = value.getFullYear();
    return `${d}-${m}-${y}`;
  }
  return value == null ? '' : String(value).trim();
}

function readMrpRevRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets['MRP Rev'];
  if (!ws) throw new Error('Sheet "MRP Rev" not found in workbook');

  const raw = XLSX.utils.sheet_to_json(ws, { range: 1, defval: '' });

  const rows = [];
  for (const r of raw) {
    const brandName = String(r['Brand Name'] || '').trim();
    if (!brandName) continue;

    rows.push({
      srNo: r['Sr. No'],
      brandName,
      composition: String(r['Drug (Composition DCA)'] || '').trim(),
      dosage: String(r['Dosage (Product Type)'] || '').trim(),
      size: String(r['Size (Unit Pack)'] || '').trim(),
      manufacturer: String(r['Manufacturer'] || '').trim(),
      gstPct: r['GST %'],
      prevMrp: r[' Previous MRP'] !== undefined ? r[' Previous MRP'] : r['Previous MRp '],
      ptd: r['PTD Without GST'],
      ptr: r['PTR Without GST'],
      mrp: r['Revised MRP'],
      batchNo: String(r['Batch No'] || '').trim(),
      effectiveDate: excelDateToDDMMYYYY(r['Effective Date']),
    });
  }
  return rows;
}

function groupByManufacturer(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.manufacturer.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, { manufacturer: row.manufacturer, rows: [] });
    groups.get(key).rows.push(row);
  }
  return Array.from(groups.values());
}

module.exports = { readMrpRevRows, groupByManufacturer };
```

---

## `lib/match.js`

Uses `string-similarity` (Dice coefficient bigram algorithm) for fuzzy product name matching.

### Key logic

```
normalizeText(s):
  - replace & → " and "
  - lowercase
  - strip trailing (...) — removes boilerplate like "(10.00 Tablet)" from dropdown options
  - strip punctuation [.,'"_/-] (keep spaces)
  - collapse whitespace

DOSAGE_FORM_MAP:
  tab/tabs/tablet/tablets    → "tablet"
  cap/caps/capsule/capsules  → "capsule"
  inj/injection              → "injection"
  syr/syrup/solution         → "solution"
  susp/suspension            → "suspension"
  cream                      → "cream"
  oint/ointment              → "ointment"
  gel                        → "gel"
  drop/drops                 → "drops"
  sachet                     → "sachet"
  vial/amp/ampoule           → "injection"

buildProductSearchString(row):
  brandBase = row.brandName with hyphens → spaces
  strength  = regex /(\d+(?:\.\d+)?)\s*(mg|mcg|gm|g|ml|iu|%)/i
              from brandName first, fallback to composition
              normalize "g" → "gm"
  form      = DOSAGE_FORM_MAP[row.dosage.toLowerCase()] or raw dosage
  packCount = from row.size: match /(?:\*\s*)?(\d+)\s*[a-zA-Z]/
              e.g. "1 * 10 Tabs" → "10", "10 Tabs" → "10"
  return [brandBase, strength, form, packCount].filter(Boolean).join(' ')

AMBIGUITY_MARGIN = 0.04
HIGH_CONFIDENCE  = 0.9

bestMatch(query, candidates, threshold=0.45):
  1. Normalize query and all candidates
  2. Exact normalized match → return immediately (score 1.0)
  3. stringSimilarity.findBestMatch on normalized strings
  4. If best score < threshold → no match (return null)
  5. If best score < HIGH_CONFIDENCE AND (best - second) < AMBIGUITY_MARGIN
     → ambiguous: return { match: null, ambiguous: true, candidates: [best, second] }
  6. Otherwise → return the match
```

### Full implementation

```javascript
const stringSimilarity = require('string-similarity');

const DOSAGE_FORM_MAP = {
  tab: 'tablet', tabs: 'tablet', tablet: 'tablet', tablets: 'tablet',
  cap: 'capsule', caps: 'capsule', capsule: 'capsule', capsules: 'capsule',
  inj: 'injection', injection: 'injection',
  syr: 'solution', syrup: 'solution', solution: 'solution',
  susp: 'suspension', suspension: 'suspension',
  cream: 'cream', oint: 'ointment', ointment: 'ointment',
  gel: 'gel', drop: 'drops', drops: 'drops',
  sachet: 'sachet', vial: 'injection', amp: 'injection', ampoule: 'injection',
};

function normalizeText(s) {
  return String(s || '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/\([^)]*\)\s*$/, '')
    .replace(/[.,'"]/g, '')
    .replace(/[-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AMBIGUITY_MARGIN = 0.04;
const HIGH_CONFIDENCE = 0.9;

function bestMatch(query, candidates, threshold = 0.45) {
  if (!candidates.length) return { match: null, score: 0, ambiguous: false };
  const normQuery = normalizeText(query);
  const normCandidates = candidates.map((c) => normalizeText(c));

  const exactIdx = normCandidates.indexOf(normQuery);
  if (exactIdx !== -1) return { match: candidates[exactIdx], score: 1, index: exactIdx, ambiguous: false };

  const { ratings, bestMatch: bm, bestMatchIndex } = stringSimilarity.findBestMatch(normQuery, normCandidates);
  if (bm.rating < threshold) {
    return { match: null, score: bm.rating, index: bestMatchIndex, ambiguous: false };
  }

  const sorted = ratings.map((r, i) => ({ rating: r.rating, i })).sort((a, b) => b.rating - a.rating);
  const second = sorted[1];
  const ambiguous = bm.rating < HIGH_CONFIDENCE && second && (bm.rating - second.rating) < AMBIGUITY_MARGIN;

  if (ambiguous) {
    return {
      match: null, score: bm.rating, index: bestMatchIndex,
      ambiguous: true, candidates: [candidates[bestMatchIndex], candidates[second.i]],
    };
  }

  return { match: candidates[bestMatchIndex], score: bm.rating, index: bestMatchIndex, ambiguous: false };
}

function extractStrength(compositionOrBrand) {
  const m = String(compositionOrBrand || '').match(/(\d+(?:\.\d+)?)\s*(mg|mcg|gm|g|ml|iu|%)/i);
  return m ? `${m[1]} ${m[2].toLowerCase() === 'g' ? 'gm' : m[2].toLowerCase()}` : '';
}

function extractPackCount(sizeStr) {
  const m = String(sizeStr || '').match(/(?:\*\s*)?(\d+)\s*[a-zA-Z]/);
  return m ? m[1] : '';
}

function mapDosageForm(dosage) {
  const key = String(dosage || '').toLowerCase().trim();
  return DOSAGE_FORM_MAP[key] || key;
}

function buildProductSearchString(row) {
  const brandBase = row.brandName.replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
  const strength = extractStrength(row.brandName) || extractStrength(row.composition);
  const form = mapDosageForm(row.dosage);
  const packCount = extractPackCount(row.size);
  return [brandBase, strength, form, packCount].filter(Boolean).join(' ');
}

module.exports = { normalizeText, bestMatch, buildProductSearchString };
```

---

## `lib/frames.js`

The portal embeds all form content inside an `<iframe>`. Never use `page.locator()` directly for form elements.

```javascript
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
      console.log(`  ... still waiting for "${selector}" (${elapsed}s elapsed, frames seen: ${page.frames().length})`);
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
```

---

## `lib/chosenSelect.js`

The portal uses **chosen.js** jQuery plugin for styled dropdowns. The real `<select>` is hidden; chosen renders a custom UI on top. Drive it by setting the real select value + triggering events.

```javascript
async function getSelectOptions(frame, selectId) {
  return frame.evaluate((id) => {
    const sel = document.getElementById(id);
    if (!sel) return [];
    return Array.from(sel.options)
      .filter((o) => o.value !== '' && o.value !== '0')
      .map((o) => ({ value: o.value, text: o.text }));
  }, selectId);
}

async function setSelectValue(frame, selectId, value) {
  await frame.evaluate(({ id, val }) => {
    const sel = document.getElementById(id);
    sel.value = val;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery) {
      try { window.jQuery(sel).trigger('chosen:updated'); } catch (_) {}
    }
  }, { id: selectId, val: value });
}

module.exports = { getSelectOptions, setSelectValue };
```

---

## `lib/debug.js`

```javascript
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
  console.log(`  [debug] saved ${base}.png / .html in ./debug`);
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
```

---

## `index.js` — Main Script

### Constants

```javascript
const PORTAL_URL    = 'https://nppaipdms.gov.in/IMCS/hissso/logoutLogin.imcs';
const LOGIN_TIMEOUT = 5 * 60 * 1000;   // 5 min — wait for manual login
const NAV_TIMEOUT   = 90 * 1000;       // 90s for page elements
const EXCEL_PATH    = process.argv[2] || '/Users/avinash/Desktop/DPCO/Form 5 26-05-25.xlsx';
```

### Browser launch — bot detection avoidance

> **Critical:** Without these flags, the government site loads 10x slower and may block automation.

```javascript
const context = await chromium.launchPersistentContext('.chrome-profile', {
  channel: 'chrome',        // real Chrome binary, not bundled Chromium
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
```

### `gotoWithRetry(page, url, attempts=3)`

Navigate with `waitUntil: 'domcontentloaded'` (NOT `'load'` — a CDN resource is blocked by ORB so `load` never fires), 60s timeout per attempt, up to 3 retries with 2s gap.

### `goToAddForm(page)`

1. `waitForElementInFrames(page, 'a#addbtn button', NAV_TIMEOUT)` → click
2. Wait 1500ms
3. Poll `findFormFrame(page)` every 500ms until the form frame appears (contains `#productId`, `#manufacturerCompanyId`, `#caseFlag`)

### `selectChosenByMatch(frame, selectId, queryText, label)`

1. `getSelectOptions(frame, selectId)`
2. `bestMatch(queryText, options.map(o => o.text))`
3. No match → log `[FLAG]`, return false
4. `setSelectValue(frame, selectId, options[index].value)` → return true

### `waitForProductDetailsLoaded(frame, timeout=15000)`

After selecting a product, the page fires an AJAX call that auto-fills `#composition`, `#strength`, etc. Poll every 300ms until `document.getElementById('composition').value.trim()` is non-empty. Return true/false.

### `fillProductRow(frame, row)`

1. `buildProductSearchString(row)` → `bestMatch` against `#productId` options
2. If `ambiguous` → push to `flaggedRows`, return false
3. If no match → push to `flaggedRows`, return false
4. `setSelectValue(frame, 'productId', ...)` → `waitForProductDetailsLoaded`
5. Fill numeric fields:
   - `#pts` ← `row.ptd`  (**DOM id is `pts`, not `ptd`** — not a typo, that's what the portal uses)
   - `#ptr` ← `row.ptr`
   - `#prevRevMrp` ← `row.prevMrp`
   - `#mrp` ← `row.mrp`
   - `#gst` ← `Math.round(Number(row.gstPct) * 100)`
   - `#effectiveBatchNo` ← `row.batchNo.toUpperCase()`
6. `setEffectiveDate(frame, row.effectiveDate)`

### `setEffectiveDate(frame, ddmmyyyy)` — the tricky one

The field uses **bootstrap-datepicker** (eternicode). Typing into the field doesn't work — the widget intercepts and reformats the text as `Mon-YYYY`. Must use the jQuery datepicker API.

**Problem:** `window.jQuery` on this page is v1.10.1 and does NOT have `.fn.datepicker` registered. The datepicker plugin is registered on a separate jQuery instance (noConflict pattern used by legacy government portal code).

**Solution:** Scan all `window` globals for any that look like jQuery (have `.fn.jquery` string) AND have `.fn.datepicker` attached:

```javascript
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
    console.log(`  [debug] diag: ${JSON.stringify(result.diag)}`);
    return false;
  }
  console.log(`  Effective Date set -> "${result.value}"`);
  return true;
}
```

If `jQueryGlobalWithDatepicker` is still `null` after this (meaning the datepicker is inside a closure with no global reference), fall back to clicking the calendar UI directly: press `Escape` first to close any open picker, click `#effectiveDate`, navigate to correct month using `.prev`/`.next` buttons, then click the correct day `<td>`.

### `clickAddProduct(page, frame, row)`

1. `frame.page().keyboard.press('Escape')` — close any open datepicker
2. `findOpenWidget(frame)` — if still visible, `frame.locator('body').click({ position: { x: 2, y: 2 }, force: true })`
3. Wait 200ms
4. `frame.click('#addPrd', { timeout: 8000 })`
5. Wait 1500ms for AJAX to process

### `processGroup(page, frame, group, isLastGroup)`

1. `selectChosenByMatch(frame, 'manufacturerCompanyId', group.manufacturer, 'Manufacturer')`
   - On fail: push to `flaggedRows`, skip entire group
2. Read current `#companyId` selected text → `selectChosenByMatch(frame, 'marketingCompanyId', ...)`
3. `frame.click('#caseFlag')` → wait 1000ms → `waitForElementInFrames(page, '#productId', NAV_TIMEOUT)`
4. Loop rows: `fillProductRow` → if ok, `clickAddProduct`; on error, snapshot + push to `flaggedRows`
5. Print: `Group "X" done. Please review the entries in the browser and click Submit yourself.`
6. If not last group: readline prompt — user presses Enter to continue to next group

### Main flow

```javascript
(async () => {
  // launch browser
  // addInitScript → navigator.webdriver = undefined
  // gotoWithRetry(PORTAL_URL)
  // waitForElementInFrames('#FORM_V', LOGIN_TIMEOUT)  ← user logs in manually here
  // click FORM_V link
  // readMrpRevRows(EXCEL_PATH) → groupByManufacturer
  // for each group:
  //   goToAddForm(page) → processGroup(page, frame, group, isLast)
  // if flaggedRows.length: write flagged-rows.json
  // leave browser open
})();
```

---

## Key Gotchas / Hard-Won Fixes

| # | Problem | Fix |
|---|---|---|
| 1 | Site loads 10x slower in Playwright than normal Chrome | `--disable-blink-features=AutomationControlled` + `ignoreDefaultArgs: ['--enable-automation']` + `navigator.webdriver = undefined` + `channel: 'chrome'` + `launchPersistentContext` |
| 2 | Form elements are inside an `<iframe>` | Never use `page.locator()` for form fields — always search `page.frames()` |
| 3 | chosen.js dropdowns are synthetic UI | Set the real hidden `<select>` + dispatch `change` event + trigger `chosen:updated` |
| 4 | bootstrap-datepicker eats typed input | Cannot `frame.fill('#effectiveDate', value)` — must use jQuery `.datepicker('setDate', ...)` API |
| 5 | `window.jQuery` (v1.10.1) has no `.fn.datepicker` | The plugin is on a different jQuery global (noConflict). Scan all `Object.keys(window)` for one that has both `.fn.jquery` and `.fn.datepicker` |
| 6 | Open datepicker popup blocks "Add" button | Press Escape + click body at `{x:2, y:2}` before clicking `#addPrd` |
| 7 | Product details don't fill instantly after selection | After setting `#productId`, wait for `#composition` to be non-empty (AJAX auto-fill) |
| 8 | `waitUntil: 'load'` times out | CDN resource `cdn.jsdelivr.net/npm/jvectormap@2.0.5/jquery-jvectormap.css` is blocked by ORB, preventing `load` from firing. Use `domcontentloaded` everywhere |
| 9 | PTD field DOM id is `#pts` | Not a typo — the portal's HTML uses `id="pts"` for the PTD input |
| 10 | Excel `prevMrp` column header has a leading space | Header is `' Previous MRP'` (with space), handle both variants |

---

## Output

- **Console:** logs each row's match result, field values set, and any flags
- **`flagged-rows.json`:** written at end if any rows could not be auto-processed (ambiguous match, no match, date parse failure, AJAX timeout)
- **`debug/`:** PNG screenshot + HTML dump saved automatically on any `clickAddProduct` failure

---

## Excel File Reference

Default path: `/Users/avinash/Desktop/DPCO/Form 5 26-05-25.xlsx`  
Sheet: `MRP Rev`  
~63 data rows across ~10 manufacturer groups
