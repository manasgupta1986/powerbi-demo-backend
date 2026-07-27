async function configureSidePanel() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: true
      });
    }
  } catch (error) {
    console.error("Failed to configure side panel:", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await configureSidePanel();
});

chrome.runtime.onStartup.addListener(async () => {
  await configureSidePanel();
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open && tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (error) {
    console.error("Failed to open side panel:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING_EXTENSION") {
    sendResponse({
      ok: true,
      extension: "Data Myner Analyst Console"
    });
    return true;
  }

  if (message?.type === "OPEN_SIDE_PANEL") {
    (async () => {
      try {
        const targetWindowId = sender?.tab?.windowId;
        if (chrome.sidePanel && chrome.sidePanel.open && targetWindowId) {
          await chrome.sidePanel.open({ windowId: targetWindowId });
        }
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error.message || "Failed to open side panel"
        });
      }
    })();
    return true;
  }

  return false;
});
