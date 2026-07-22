function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getElementText(el) {
  return [
    el.innerText,
    el.textContent,
    el.getAttribute && el.getAttribute("aria-label"),
    el.getAttribute && el.getAttribute("title")
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function dispatchRealClick(el) {
  el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

  const events = ["mouseover", "mousedown", "mouseup", "click"];
  for (const eventName of events) {
    el.dispatchEvent(
      new MouseEvent(eventName, {
        view: window,
        bubbles: true,
        cancelable: true
      })
    );
  }
}

async function logLine(line) {
  try {
    await chrome.runtime.sendMessage({ type: "logStatus", line });
  } catch (err) {
    // ignore
  }
}

function getAllCandidates() {
  return Array.from(
    document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="option"], [aria-label], span, div'
    )
  );
}

function findBestMatch(targetText) {
  const target = normalize(targetText);
  const candidates = [];

  for (const el of getAllCandidates()) {
    if (!isVisible(el)) continue;

    const text = getElementText(el);
    const textNorm = normalize(text);
    if (!textNorm) continue;

    let score = 0;

    if (textNorm === target) score = 1000;
    else if (textNorm.includes(target)) score = 700;
    else if (target.includes(textNorm)) score = 400;
    else continue;

    if (el.getAttribute("role") === "tab") score += 50;
    if (el.tagName === "BUTTON") score += 40;

    score -= Math.abs(textNorm.length - target.length);

    candidates.push({ el, text, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function clickByText(targetText, purposeLabel) {
  const match = findBestMatch(targetText);

  if (!match) {
    await logLine(`${purposeLabel}: could not find "${targetText}"`);
    return {
      ok: false,
      note: `${purposeLabel}: could not find "${targetText}"`
    };
  }

  await logLine(`${purposeLabel}: matched "${match.text.slice(0, 120)}"`);

  dispatchRealClick(match.el);
  await sleep(1200);

  return {
    ok: true,
    note: `${purposeLabel}: clicked "${targetText}" using "${match.text.slice(0, 120)}"`
  };
}

function closeOpenLayer() {
  document.body.dispatchEvent(
    new MouseEvent("click", {
      view: window,
      bubbles: true,
      cancelable: true
    })
  );
}

async function switchPage(pageName) {
  await logLine(`Attempting to open page "${pageName}"`);

  const result = await clickByText(pageName, "Open page");
  await sleep(1800);

  return {
    ok: result.ok,
    note: result.note
  };
}

async function resetFilter(filterName, allLabel) {
  await logLine(`Resetting filter "${filterName}" to "${allLabel}"`);

  const openResult = await clickByText(filterName, "Open filter");
  if (!openResult.ok) {
    return {
      ok: false,
      note: openResult.note
    };
  }

  await sleep(1000);

  const allResult = await clickByText(allLabel, "Select all");
  await sleep(1200);

  closeOpenLayer();
  await sleep(800);

  return {
    ok: allResult.ok,
    note: allResult.note
  };
}

async function applyFilterOption(filterName, optionLabel, allLabel) {
  await logLine(`Selecting ${filterName} = ${optionLabel}`);

  const openResult = await clickByText(filterName, "Open filter");
  if (!openResult.ok) {
    return {
      ok: false,
      note: openResult.note
    };
  }

  await sleep(1000);

  const optionResult = await clickByText(optionLabel, "Choose option");
  await sleep(1500);

  const visibleText = getVisibleText();
  const verified = normalize(visibleText).includes(normalize(optionLabel));

  closeOpenLayer();
  await sleep(800);

  return {
    ok: optionResult.ok,
    note: optionResult.ok
      ? `Selected ${filterName} = ${optionLabel}. Verification: ${verified ? "option text visible on page" : "option text not clearly visible after click"}`
      : optionResult.note
  };
}

function getVisibleText() {
  return String(document.body?.innerText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "ping") {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "getVisibleText") {
      sendResponse({
        ok: true,
        visibleText: getVisibleText()
      });
      return;
    }

    if (message?.type === "switchPage") {
      const result = await switchPage(message.pageName);
      sendResponse(result);
      return;
    }

    if (message?.type === "resetFilter") {
      const result = await resetFilter(message.filterName, message.allLabel);
      sendResponse(result);
      return;
    }

    if (message?.type === "applyFilterOption") {
      const result = await applyFilterOption(
        message.filterName,
        message.optionLabel,
        message.allLabel
      );
      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, note: "Unknown content message type." });
  })();

  return true;
});
