let cachedScrollTarget = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "MODE_B_RESET_SCROLL_TOP": {
          const target = findMainScrollTarget();
          cachedScrollTarget = target;
          setScrollTop(target, 0);
          await sleep(300);
          sendResponse({ ok: true, ...readMetrics(target) });
          return;
        }

        case "MODE_B_GET_SCROLL_METRICS": {
          const target = cachedScrollTarget || findMainScrollTarget();
          cachedScrollTarget = target;
          sendResponse({ ok: true, ...readMetrics(target) });
          return;
        }

        case "MODE_B_SCROLL_NEXT": {
          const target = cachedScrollTarget || findMainScrollTarget();
          cachedScrollTarget = target;

          const before = getScrollTop(target);
          const metricsBefore = readMetrics(target);
          const step = Math.max(240, Math.floor((metricsBefore.clientHeight || window.innerHeight) * 0.82));

          setScrollTop(target, before + step);
          await sleep(450);

          const after = getScrollTop(target);
          const metricsAfter = readMetrics(target);

          sendResponse({
            ok: true,
            changed: Math.round(after) !== Math.round(before),
            scrollY: metricsAfter.scrollY,
            bottomReached: metricsAfter.bottomReached,
            viewportWidth: metricsAfter.viewportWidth,
            viewportHeight: metricsAfter.viewportHeight,
            totalScrollHeight: metricsAfter.totalScrollHeight,
            clientHeight: metricsAfter.clientHeight
          });
          return;
        }

        default:
          sendResponse({ ok: false, error: `Unknown content message type: ${message.type}` });
          return;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

function findMainScrollTarget() {
  const candidates = [];
  const all = [...document.querySelectorAll("*")];

  for (const el of all) {
    try {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY || "";
      const rect = el.getBoundingClientRect();

      const canScroll =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        el.scrollHeight > el.clientHeight + 80 &&
        rect.width > 500 &&
        rect.height > 250;

      if (!canScroll) continue;

      const score =
        Math.min(rect.width, window.innerWidth) *
        Math.min(rect.height, window.innerHeight) +
        (el.scrollHeight - el.clientHeight);

      candidates.push({ el, score });
    } catch { /* ignore */ }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length) return candidates[0].el;
  return document.scrollingElement || document.documentElement || document.body;
}

function readMetrics(target) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  if (isWindowScrollTarget(target)) {
    const totalScrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    const clientHeight = window.innerHeight;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const bottomReached = scrollY + clientHeight >= totalScrollHeight - 8;

    return { scrollY, viewportWidth, viewportHeight, totalScrollHeight, clientHeight, bottomReached };
  }

  const scrollY = target.scrollTop || 0;
  const totalScrollHeight = target.scrollHeight || 0;
  const clientHeight = target.clientHeight || 0;
  const bottomReached = scrollY + clientHeight >= totalScrollHeight - 8;

  return { scrollY, viewportWidth, viewportHeight, totalScrollHeight, clientHeight, bottomReached };
}

function getScrollTop(target) {
  if (isWindowScrollTarget(target)) return window.scrollY || window.pageYOffset || 0;
  return target.scrollTop || 0;
}

function setScrollTop(target, value) {
  if (isWindowScrollTarget(target)) { window.scrollTo(0, Math.max(0, value)); return; }
  target.scrollTop = Math.max(0, value);
}

function isWindowScrollTarget(target) {
  return (
    target === window ||
    target === document.body ||
    target === document.documentElement ||
    target === document.scrollingElement
  );
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
