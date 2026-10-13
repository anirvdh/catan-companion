// content_bridge.js
// The interceptor.js runs in page context (injected via manifest content_scripts)
// This bridge runs in the extension content script context and relays events to background

// True only while this content script is still attached to a live extension. After the
// extension is reloaded/updated, already-open tabs keep the OLD (orphaned) scripts running;
// chrome.runtime.id becomes undefined and chrome.runtime.sendMessage throws synchronously
// ("Extension context invalidated"). We detect that and go quiet (the page needs a refresh).
let contextAlive = true;

function relay(msg) {
  if (!contextAlive || !chrome.runtime || !chrome.runtime.id) return;
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && /context invalidated/i.test(err.message || '')) { contextAlive = false; return; }
        // Service worker may be restarting — retry once after a short delay.
        setTimeout(() => { try { const r = chrome.runtime.sendMessage(msg); if (r && r.catch) r.catch(() => {}); } catch (e) {} }, 500);
      });
    }
  } catch (e) {
    // Orphaned after an extension reload — stop trying until the page is refreshed.
    contextAlive = false;
  }
}

window.addEventListener('catan_game_event', (e) => {
  relay({ type: 'GAME_EVENT', payload: e.detail });
});

window.addEventListener('catan_raw_message', (e) => {
  relay({ type: 'RAW_MESSAGE', payload: e.detail });
});

console.log('[CatanExt] Content bridge ready ✓');
