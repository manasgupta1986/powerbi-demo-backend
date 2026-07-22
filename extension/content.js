function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function appendRunLog(line) {
  const existing = await chrome.storage.local.get(['runLog']);
  const runLog = Array.isArray(existing.runLog) ? existing.runLog : [];
  runLog.push(`${new Date().toLocaleTimeString()} ${line}`);
  await chrome.storage.local.set({ runLog: runLog.slice(-200) });
}

async function setRunStatus(text) {
  await chrome.storage.local.set({ runStatus: text });
  await appendRunLog(text);
}

function getVisibleText() {
  const text = (document.body?.innerText || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return text.slice(0, 18000);
}

function getClickableCandidates() {
  return [...document.querySelectorAll('button, a, div, span, label')].filter(el => {
    const text = (el.innerText || el.textContent || '').trim();
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return text && rect.width > 20 && rect.height > 12 && style.visibility !== 'hidden' && style.display !== 'none';
  });
}

function scoreMatch(candidateText, target) {
  const a = candidateText.toLowerCase();
  const b = target.toLowerCase();
  if (a === b) return 100;
  if (a.includes(b)) return 80;
  if (b.includes(a)) return 60;
  return 0;
}

async function clickByText(targetText) {
  const candidates = getClickableCandidates();
  const scored = candidates
    .map(el => ({ el, text: (el.innerText || el.textContent || '').trim(), score: scoreMatch((el.innerText || el.textContent || '').trim(), targetText) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { clicked: false, matchedText: '' };

  const winner = scored[0].el;
  const matchedText = scored[0].text;
  winner.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(700);
  winner.click();
  return { clicked: true, matchedText };
}

async function tryClick(targetText, waitAfter = 2500) {
  await setRunStatus(`Status: trying click on "${targetText}"...`);
  try {
    const result = await clickByText(targetText);
    if (result.clicked) {
      await appendRunLog(`Clicked target "${targetText}" using element text "${result.matchedText}"`);
      await sleep(waitAfter);
      return { clicked: true, matchedText: result.matchedText };
    }
  } catch (e) {
    await appendRunLog(`Error while clicking "${targetText}": ${e.message}`);
  }
  await appendRunLog(`Could not find a clickable element for "${targetText}"`);
  return { clicked: false, matchedText: '' };
}

async function selectFilterOption(filterName, optionText, waitAfter = 3000) {
  await setRunStatus(`Status: opening filter ${filterName}...`);
  const filterOpen = await tryClick(filterName, 1500);
  await sleep(800);

  await setRunStatus(`Status: selecting ${filterName} = ${optionText}...`);
  const optionResult = await tryClick(optionText, waitAfter);

  return {
    filterOpenClicked: filterOpen.clicked,
    optionClicked: optionResult.clicked,
    matchedText: optionResult.matchedText
  };
}

async function captureVisibleState() {
  return await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'captureVisibleState' }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response from background screenshot capture' });
    });
  });
}

async function captureSingleState(state, pageName, navigationInfo = {}) {
  const screenshot = await captureVisibleState();
  if (screenshot.ok) {
    await appendRunLog(`Screenshot captured for ${state.filterName || 'Overall'}=${state.filterValue || 'All'} | ${pageName}`);
  } else {
    await appendRunLog(`Screenshot failed for ${state.filterName || 'Overall'}=${state.filterValue || 'All'} | ${pageName}: ${screenshot.error || 'Unknown error'}`);
  }

  return {
    ...state,
    pageName,
    extractedText: getVisibleText(),
    capturedAt: new Date().toISOString(),
    imageDataUrl: screenshot.ok ? screenshot.imageDataUrl : '',
    screenshotCaptured: !!screenshot.ok,
    navigationInfo
  };
}

async function capturePagesForState(pageNames, state) {
  const captures = [];

  if (!pageNames.length) {
    captures.push(await captureSingleState(state, 'Current View', { pageClicked: true, matchedText: 'Current View' }));
    return captures;
  }

  for (const pageName of pageNames) {
    await setRunStatus(`Status: ${state.filterName} = ${state.filterValue} | opening ${pageName}...`);
    const pageClick = await tryClick(pageName, 3200);

    captures.push(await captureSingleState(state, pageName, {
      pageClicked: pageClick.clicked,
      matchedText: pageClick.matchedText
    }));
  }

  return captures;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'runFilterSweep') return;

  (async () => {
    const pageNames = Array.isArray(message.pageNames) ? message.pageNames : [];
    const filters = Array.isArray(message.filters) ? message.filters : [];
    const timeFilterText = message.timeFilterText || '';
    const captures = [];

    await setRunStatus('Status: content script received the screenshot sweep request...');
    await sleep(3500);

    if (timeFilterText) {
      await setRunStatus(`Status: trying time filter "${timeFilterText}"...`);
      await tryClick(timeFilterText, 2500);
    }

    await setRunStatus('Status: capturing overall baseline across all tabs before filters...');
    const baselineCaptures = await capturePagesForState(pageNames, {
      filterName: 'Overall',
      filterValue: 'All',
      baseline: true,
      timeFilterText
    });
    captures.push(...baselineCaptures);

    for (const filter of filters) {
      const filterName = filter.filterName || 'Unknown Filter';
      const allLabel = filter.allLabel || 'All';
      const options = Array.isArray(filter.options) ? filter.options : [];

      await setRunStatus(`Status: resetting ${filterName} to ${allLabel}...`);
      await selectFilterOption(filterName, allLabel, 2500);

      for (const option of options) {
        const selectionInfo = await selectFilterOption(filterName, option, 3000);

        await setRunStatus(`Status: capturing tabs for ${filterName} = ${option}...`);
        const stateCaptures = await capturePagesForState(pageNames, {
          filterName,
          filterValue: option,
          timeFilterText,
          selectionInfo
        });

        captures.push(...stateCaptures);
      }

      await setRunStatus(`Status: restoring ${filterName} to ${allLabel}...`);
      await selectFilterOption(filterName, allLabel, 2500);
    }

    await setRunStatus(`Status: sweep finished locally with ${captures.length} captures. Sending response...`);
    sendResponse({ ok: true, captures });
  })().catch(async err => {
    await setRunStatus(`Status: content script failed. ${err.message}`);
    sendResponse({ ok: false, error: err.message });
  });

  return true;
});
