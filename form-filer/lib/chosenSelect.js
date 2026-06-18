'use strict';

const { chooseCandidate } = require('./aiMatch');

/**
 * Human-like chosen.js dropdown selection.
 * Types one character at a time into the search field until only one
 * option remains, then clicks it — mirroring how a human narrows down a list.
 */
function normalizeForPortal(text) {
  return String(text || '')
    .replace(/&/g, 'and')
    .replace(/-/g, ' ')   // hyphens → spaces: the portal's canonical names use spaces
    .replace(/\s+/g, ' ')
    .trim();
}

async function selectByTyping(frame, selectId, searchText, label) {
  const containerId = `${selectId}_chosen`;
  searchText = normalizeForPortal(searchText);

  // Open the dropdown by clicking the single-select trigger
  const trigger = frame.locator(`#${containerId} .chosen-single, #${containerId} .chosen-choices`);
  if (await trigger.count() === 0) {
    console.log(`  [FLAG] Chosen trigger not found for ${label} (#${containerId})`);
    return false;
  }
  await trigger.first().click();
  await frame.waitForTimeout(350);

  // Locate the search input inside the open dropdown
  const searchInput = frame.locator(`#${containerId} .chosen-search input`);
  if (await searchInput.count() === 0) {
    console.log(`  [FLAG] Chosen search input not found for ${label}`);
    await frame.page().keyboard.press('Escape').catch(() => {});
    return false;
  }
  await searchInput.click();
  // Clear any stale text left over from a previous failed search attempt.
  await searchInput.fill('');
  await frame.waitForTimeout(150);

  const activeOptions = frame.locator(`#${containerId} .chosen-results li.active-result`);

  let typedSoFar = '';
  for (const char of searchText) {
    await searchInput.pressSequentially(char, { delay: 60 });
    typedSoFar += char;
    await frame.waitForTimeout(200);

    let count = await activeOptions.count();

    // Separators are ambiguous in the portal: the same product may be stored with
    // a space, a hyphen, or no separator at all. We always type a space (hyphens
    // are normalized to spaces upfront). If a space yields nothing, retry the
    // position as a hyphen, then as no separator, before giving up.
    if (count === 0 && char === ' ') {
      await searchInput.press('Backspace');
      await searchInput.pressSequentially('-', { delay: 60 });
      await frame.waitForTimeout(200);
      count = await activeOptions.count();

      if (count > 0) {
        typedSoFar = typedSoFar.slice(0, -1) + '-';
      } else {
        // Drop the separator entirely (portal may concatenate, e.g. "Bacloren20").
        await searchInput.press('Backspace');
        await frame.waitForTimeout(200);
        typedSoFar = typedSoFar.slice(0, -1);
        count = await activeOptions.count();
      }
    }

    if (count === 0) {
      console.log(`  [FLAG] 0 options after typing "${typedSoFar}" for ${label}`);
      await frame.page().keyboard.press('Escape').catch(() => {});
      return false;
    }

    if (count === 1) {
      const optionText = await activeOptions.first().textContent();
      console.log(`  ${label}: 1 option after "${typedSoFar}" → "${optionText?.trim()}"`);
      await activeOptions.first().click();
      return true;
    }
  }

  // Full text typed — still multiple options, pick the first
  const remaining = frame.locator(`#${containerId} .chosen-results li.active-result`);
  const remainingCount = await remaining.count();

  if (remainingCount === 0) {
    console.log(`  [FLAG] No options after full text for ${label}: "${searchText}"`);
    await frame.page().keyboard.press('Escape').catch(() => {});
    return false;
  }

  const firstText = await remaining.first().textContent();
  if (remainingCount > 1) {
    console.log(`  [WARN] ${remainingCount} options remain for ${label} after "${searchText}" — selecting first: "${firstText?.trim()}"`);
  } else {
    console.log(`  ${label}: selecting "${firstText?.trim()}"`);
  }
  await remaining.first().click();
  return true;
}

/** Open a chosen dropdown and return its search input + active-options locators. */
async function openChosen(frame, selectId, label) {
  const containerId = `${selectId}_chosen`;

  const trigger = frame.locator(`#${containerId} .chosen-single, #${containerId} .chosen-choices`);
  if (await trigger.count() === 0) {
    console.log(`  [FLAG] Chosen trigger not found for ${label} (#${containerId})`);
    return null;
  }
  await trigger.first().click();
  await frame.waitForTimeout(350);

  const searchInput = frame.locator(`#${containerId} .chosen-search input`);
  if (await searchInput.count() === 0) {
    console.log(`  [FLAG] Chosen search input not found for ${label}`);
    await frame.page().keyboard.press('Escape').catch(() => {});
    return null;
  }
  await searchInput.click();
  await searchInput.fill('');  // clear stale text from a prior failed search
  await frame.waitForTimeout(150);

  const activeOptions = frame.locator(`#${containerId} .chosen-results li.active-result`);
  return { searchInput, activeOptions };
}

/**
 * Type text into the open search box character by character.
 * On a space that yields nothing, retry it as a hyphen. If a character
 * eliminates all options, back it off and stop — we keep the last non-empty
 * candidate set and disambiguate from there (rather than giving up at 0).
 */
async function typeWithSeparatorFallback(frame, searchInput, activeOptions, text) {
  let typed = '';
  for (const char of text) {
    await searchInput.pressSequentially(char, { delay: 60 });
    await frame.waitForTimeout(180);
    let count = await activeOptions.count();

    if (count === 0 && char === ' ') {
      // portal may store a hyphen where the brand uses a space
      await searchInput.press('Backspace');
      await searchInput.pressSequentially('-', { delay: 60 });
      await frame.waitForTimeout(180);
      count = await activeOptions.count();
      if (count > 0) {
        typed += '-';
        continue;
      }
      // neither space nor hyphen matched — drop the separator and stop here
      await searchInput.press('Backspace');
      await frame.waitForTimeout(150);
      break;
    }

    if (count === 0) {
      // this character eliminated everything — back it off and stop, keeping
      // the candidates from the longest prefix that still matched something
      await searchInput.press('Backspace');
      await frame.waitForTimeout(150);
      break;
    }

    typed += char;
  }
  return { count: await activeOptions.count(), typed };
}

// The brand stem is everything before the first digit; the strength (digits) is
// matched via composition instead of typed, so we never force a separator that
// the portal may store differently.
function brandStem(normalizedBrand) {
  const m = normalizedBrand.match(/^[^\d]+/);
  const stem = (m ? m[0] : normalizedBrand).trim();
  return stem || normalizedBrand;
}

/**
 * Select a product option. Types the brand stem, collects the candidate options,
 * then picks by strength (deterministic) with the LLM breaking ties.
 * Returns { ok, chosenLabel, how }.
 */
async function selectProductByTyping(frame, selectId, row, label = 'Product') {
  const handles = await openChosen(frame, selectId, label);
  if (!handles) return { ok: false };
  const { searchInput, activeOptions } = handles;

  const brand = normalizeForPortal(row.brandName);
  const stem  = brandStem(brand);

  const { count, typed } = await typeWithSeparatorFallback(frame, searchInput, activeOptions, stem);
  if (count === 0) {
    console.log(`  [FLAG] 0 options after typing "${typed}" for ${label}`);
    await frame.page().keyboard.press('Escape').catch(() => {});
    return { ok: false };
  }

  const candidates = (await activeOptions.allTextContents()).map((t) => t.trim());

  let idx = 0;
  let how = 'only';
  if (candidates.length > 1) {
    ({ idx, how } = await chooseCandidate(row, candidates));
  }

  await activeOptions.nth(idx).click();
  return { ok: true, chosenLabel: candidates[idx], how };
}

module.exports = { selectByTyping, selectProductByTyping };
