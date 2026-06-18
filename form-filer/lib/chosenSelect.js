'use strict';

/**
 * Human-like chosen.js dropdown selection.
 * Types one character at a time into the search field until only one
 * option remains, then clicks it — mirroring how a human narrows down a list.
 */
function normalizeForPortal(text) {
  return String(text || '')
    .replace(/&/g, 'and')
    // Note: hyphens are NOT pre-replaced here — selectByTyping handles them dynamically
    // because some portal entries use hyphens and some use spaces.
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

    // When a separator gives 0 results, swap it (hyphen ↔ space) and try once more.
    if (count === 0 && (char === '-' || char === ' ')) {
      const alt = char === '-' ? ' ' : '-';
      await searchInput.press('Backspace');
      typedSoFar = typedSoFar.slice(0, -1);
      await searchInput.pressSequentially(alt, { delay: 60 });
      typedSoFar += alt;
      await frame.waitForTimeout(200);
      count = await activeOptions.count();
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

module.exports = { selectByTyping };
