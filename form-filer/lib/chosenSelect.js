'use strict';

/**
 * Human-like chosen.js dropdown selection.
 * Types one character at a time into the search field until only one
 * option remains, then clicks it — mirroring how a human narrows down a list.
 */
function normalizeForPortal(text) {
  return String(text || '')
    .replace(/&/g, 'and')
    .replace(/-/g, ' ')   // hyphens → spaces (portal names use spaces, not hyphens)
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

  let typedSoFar = '';
  for (const char of searchText) {
    await searchInput.pressSequentially(char, { delay: 60 });
    typedSoFar += char;
    await frame.waitForTimeout(200);

    const activeOptions = frame.locator(`#${containerId} .chosen-results li.active-result`);
    const count = await activeOptions.count();

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
