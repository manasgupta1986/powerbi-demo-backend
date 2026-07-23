let cachedMainScrollTarget = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function isScrollableElement(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  const canByStyle = ["auto", "scroll", "overlay"].includes(style.overflowY);
  const canBySize = el.scrollHeight > el.clientHeight + 40;
  return isVisible(el) && el.clientHeight > 80 && canByStyle && canBySize;
}

function isDocumentScroller(t) {
  return t === window || t === document || t === document.documentElement || t === document.body || t === document.scrollingElement;
}

function resetCachedMainScrollTarget() { cachedMainScrollTarget = null; }

function getStableMainScrollTarget(force = false) {
  if (!force && cachedMainScrollTarget && document.contains(cachedMainScrollTarget) && isScrollableElement(cachedMainScrollTarget)) {
    return cachedMainScrollTarget;
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const all = Array.from(document.querySelectorAll("*")).filter(isScrollableElement);
  const scored = [];
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width < Math.max(320, vw * 0.45)) continue;
    if (rect.height < Math.max(220, vh * 0.4)) continue;
    let score = rect.width * rect.height / 1000;
    score += (el.scrollHeight - el.clientHeight) / 4;
    const cx = rect.left + rect.width / 2;
    score -= Math.abs(cx - vw / 2);
    if (rect.top >= 80 && rect.top <= 260) score += 160;
    scored.push({ el, score });
  }
  scored.sort((a, b) => b.score - a.score);
  cachedMainScrollTarget = scored[0]?.el || document.scrollingElement || document.documentElement || document.body;
  return cachedMainScrollTarget;
}

function readScrollMetrics(t) {
  if (isDocumentScroller(t)) {
    const se = document.scrollingElement || document.documentElement || document.body;
    const y = Math.round(window.scrollY || se.scrollTop || 0);
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const dh = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, se?.scrollHeight || 0);
    return { scrollY: y, viewportHeight: vh, documentHeight: dh, atBottom: y + vh >= dh - 8 };
  }
  return { scrollY: Math.round(t.scrollTop), viewportHeight: Math.round(t.clientHeight), documentHeight: Math.round(t.scrollHeight), atBottom: t.scrollTop + t.clientHeight >= t.scrollHeight - 8 };
}

function setScrollTop(t, top) {
  if (isDocumentScroller(t)) window.scrollTo({ top, left: 0, behavior: "instant" });
  else t.scrollTop = top;
}

async function scrollToTop() {
  const t = getStableMainScrollTarget(true);
  setScrollTop(t, 0);
  await sleep(1000);
  const m = readScrollMetrics(t);
  await logLine(`Scrolled main container to top. Y=${m.scrollY}, doc=${m.documentHeight}, viewport=${m.viewportHeight}`);
  return { ok: true, ...m };
}

async function scrollDownOne() {
  const t = getStableMainScrollTarget(false);
  const before = readScrollMetrics(t);
  const step = Math.max(300, Math.floor(before.viewportHeight * 0.75));
  setScrollTop(t, before.scrollY + step);
  await sleep(1000);
  const after = readScrollMetrics(t);
  await logLine(`Scrolled main container. Y ${before.scrollY} -> ${after.scrollY}`);
  return { ok: true, before, after };
}

function getScrollMetrics() {
  return readScrollMetrics(getStableMainScrollTarget(false));
}

async function logLine(line) {
  try { await chrome.runtime.sendMessage({ type: "logStatus", line }); } catch (e) {}
}

function elementAtCssPoint(x, y) {
  return document.elementFromPoint(x, y);
}

function dispatchAtPoint(x, y) {
  const el = elementAtCssPoint(x, y);
  if (!el) return { ok: false, note: `No element at (${x},${y})` };

  const eventNames = ["mouseover", "mousedown", "mouseup", "click"];
  for (const name of eventNames) {
    el.dispatchEvent(new MouseEvent(name, {
      view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }
  return { ok: true, note: `Clicked at (${x},${y}) tag=${el.tagName}` };
}

async function clickAtCssPoint(x, y) {
  await logLine(`Vision click at (${x}, ${y})`);
  const res = dispatchAtPoint(x, y);
  await sleep(1000);
  return res;
}

function getViewportInfo() {
  return {
    ok: true,
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

function findDropdownScrollableAtPoint(x, y) {
  const el = elementAtCssPoint(x, y);
  if (!el) return null;
  let current = el;
  for (let i = 0; i < 8 && current; i += 1) {
    if (isScrollableElement(current)) return current;
    current = current.parentElement;
  }
  return null;
}

async function scrollDropdownAtPoint(x, y, step = 100) {
  const target = findDropdownScrollableAtPoint(x, y);
  if (!target) return { ok: false, note: "No scrollable dropdown at that point" };
  const before = target.scrollTop;
  target.scrollTop = before + step;
  await sleep(600);
  const after = target.scrollTop;
  await logLine(`Dropdown scroll at (${x},${y}): ${before} -> ${after}`);
  return { ok: after !== before, before, after };
}

function getVisibleText() {
  return String(document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 30000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "ping") { sendResponse({ ok: true }); return; }
    if (message?.type === "getVisibleText") { sendResponse({ ok: true, visibleText: getVisibleText() }); return; }
    if (message?.type === "getViewportInfo") { sendResponse(getViewportInfo()); return; }
    if (message?.type === "scrollToTop") { sendResponse(await scrollToTop()); return; }
    if (message?.type === "scrollDownOneStep") { sendResponse(await scrollDownOne()); return; }
    if (message?.type === "getScrollMetrics") { sendResponse({ ok: true, ...getScrollMetrics() }); return; }
    if (message?.type === "clickAtPoint") { sendResponse(await clickAtCssPoint(message.x, message.y)); return; }
    if (message?.type === "scrollDropdownAtPoint") { sendResponse(await scrollDropdownAtPoint(message.x, message.y, message.step)); return; }
    sendResponse({ ok: false, note: "Unknown content message type." });
  })();
  return true;
});
