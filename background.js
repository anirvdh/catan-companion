// background.js - Service worker
// Two jobs:
//   1. Relay game events from the content script → side panel (when open).
//   2. Durably CAPTURE all WebSocket traffic — regardless of whether the side
//      panel is open — so the board snapshot (sent when a game loads) and full
//      game logs are never lost. The side panel pulls this buffer to write the
//      capture file, so it always contains everything, even data received before
//      the panel was opened.

let sidePanelPort = null;
let activeTabId = null;

// ─── Durable capture buffer ──────────────────────────────────────────────────
const CAP_MAX = 8000;           // ring-buffer cap (~4-5 games) — smaller = far less memory pressure
let capture = [];
let captureSeq = 0;
let dirty = false;
let persistTimer = null;

// Capturing every frame into a growing buffer is only needed when we intend to SAVE the game. In
// test mode (Save toggle OFF) we skip it entirely → the extension stays lightweight and can't bloat
// the tab. The live advisor still works because game-state frames are relayed straight to the panel.
let saveEnabled = true;
chrome.storage.local.get(['saveEnabled'], (r) => { if (typeof r.saveEnabled === 'boolean') saveEnabled = r.saveEnabled; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.saveEnabled) saveEnabled = changes.saveEnabled.newValue !== false;
});

// Restore prior capture on service-worker startup (survives SW restart / reload)
chrome.storage.local.get(['capture'], (r) => {
  if (Array.isArray(r.capture) && capture.length === 0) {
    capture = r.capture;
    captureSeq = capture.length ? (capture[capture.length - 1].i + 1) : 0;
  }
});

function persist() {
  if (!dirty) return;
  dirty = false;
  try { chrome.storage.local.set({ capture }); } catch (e) {}
}
// Debounced, silent backup (~20s). The keepAlive alarm keeps the SW — and this
// in-memory buffer — alive during a game, so this is just a crash/reload safety net.
function schedulePersist() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 20000);
}

// Normalize to the compact schema the analysis tooling expects (catan-capture/v1)
function recordCapture(payload) {
  capture.push({
    i: captureSeq++,
    t: Date.now(),
    dir: payload.direction || 'RECV',
    kind: payload.type,
    len: payload.byteLength,
    fb: payload.firstByte,
    dec: payload.decoded !== undefined ? payload.decoded : (payload.data !== undefined ? payload.data : null),
    ascii: payload.ascii,
    b64: payload.b64,
  });
  if (capture.length > CAP_MAX) capture.splice(0, capture.length - CAP_MAX);
  schedulePersist();
}

// ─── Keep service worker alive (MV3 dies after ~30s idle) ────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // every ~24s
chrome.alarms.onAlarm.addListener((alarm) => { /* firing keeps the SW alive; persist() is already debounced on writes */ });

// ─── Side Panel Connection ───────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    console.log('[BG] Side panel connected');
    port.onDisconnect.addListener(() => { sidePanelPort = null; persist(); console.log('[BG] Side panel disconnected'); });
    port.onMessage.addListener(() => {});
  }
});

// ─── Force download paths ─────────────────────────────────────────────────────
// Chrome ignores the `filename` suggestion passed to chrome.downloads.download() for
// blob URLs and dumps UUID-named files at the Downloads ROOT. The reliable fix is to
// set the path here via onDeterminingFilename. The side panel queues the intended path
// just before each download; we apply them FIFO to downloads our extension initiated.
let pendingDownloadNames = [];
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId !== chrome.runtime.id) return;   // not ours → leave to Chrome
    const name = pendingDownloadNames.shift();
    if (name) suggest({ filename: name, conflictAction: 'overwrite' });
  });
}

// ─── Content Script + Side Panel Messages ─────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'QUEUE_DOWNLOAD_NAME':                       // side panel: next download → this path
      if (message.filename) pendingDownloadNames.push(message.filename);
      sendResponse({ ok: true });
      break;

    case 'GAME_EVENT':
      if (sidePanelPort) { try { sidePanelPort.postMessage(message); } catch (e) {} }
      sendResponse({ ok: true });
      break;

    case 'RAW_MESSAGE':
      if (saveEnabled) recordCapture(message.payload); // durable capture ONLY when we intend to save
      if (sidePanelPort) { try { sidePanelPort.postMessage(message); } catch (e) {} } // live UI (if open)
      sendResponse({ ok: true });
      break;

    case 'GET_CAPTURE':                               // side panel asks for the full buffer to save
      sendResponse({ ok: true, capture, count: capture.length });
      break;

    case 'GET_CAPTURE_COUNT':
      sendResponse({ ok: true, count: capture.length });
      break;

    case 'CLEAR_CAPTURE':
      capture = []; dirty = true; persist();
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
  return true; // keep the message channel open for the (sometimes async) response
});

// ─── Extension Icon Click → Open Side Panel ──────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  activeTabId = tab.id;
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Enable side panel on colonist.io tabs ───────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes('colonist.io')) {
    chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/index.html', enabled: true });
  }
});
