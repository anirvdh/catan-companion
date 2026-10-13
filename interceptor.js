// interceptor.js - document_start, hooks WebSocket before colonist.io loads
(function() {
  'use strict';

  const OriginalWebSocket = window.WebSocket;

  function InterceptedWebSocket(url, protocols) {
    // Create the REAL socket first and return it no matter what. Every bit of our own hooking is
    // wrapped so that if ANY of it throws, colonist keeps a fully-working, untouched WebSocket —
    // the extension must never be able to stop a game from connecting/joining/reconnecting.
    const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    try {
      console.log('[CatanExt] WebSocket:', url);
      ws.addEventListener('message', function(event) {
        try { enqueueRaw(event.data, 'RECV', url); } catch(e) {}
      });
      const origSend = ws.send.bind(ws);
      ws.send = function(data) {
        try { enqueueRaw(data, 'SEND', url); } catch(e) {}
        return origSend(data);   // colonist's own send is never delayed or blocked by us
      };
    } catch (e) {
      /* hook failed → ws is still a normal, working socket */
    }
    return ws;
  }

  try {
    InterceptedWebSocket.prototype = OriginalWebSocket.prototype;
    InterceptedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    InterceptedWebSocket.OPEN = OriginalWebSocket.OPEN;
    InterceptedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    InterceptedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    window.WebSocket = InterceptedWebSocket;
  } catch (e) {
    // If we can't install the hook, leave the native WebSocket untouched — the game still works.
    window.WebSocket = OriginalWebSocket;
  }

  // ── Processing queue ─────────────────────────────────────────────────────────
  // Decoding + classification is deferred off the WebSocket callback and run in
  // short time-sliced bursts, so colonist.io's page thread is never blocked by us.
  const MAX_QUEUE = 1000;   // under overload, drop oldest rather than freeze
  const SLICE_MS  = 6;      // max ms spent processing per tick
  const queue = [];
  let draining = false;
  const now = () => (window.performance && performance.now) ? performance.now() : Date.now();

  function enqueueRaw(data, direction, url) {
    if (!data) return;
    if (data instanceof Blob) {
      // Resolve Blobs off-thread, then enqueue the ArrayBuffer
      data.arrayBuffer().then(buf => pushQueue(buf, direction, url)).catch(() => {});
      return;
    }
    pushQueue(data, direction, url);
  }

  function pushQueue(data, direction, url) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ data, direction, url });
    if (!draining) { draining = true; setTimeout(drain, 0); }
  }

  function drain() {
    const end = now() + SLICE_MS;
    while (queue.length) {
      const item = queue.shift();
      try { processRawMessage(item.data, item.direction, item.url); } catch (e) {}
      if (now() >= end) break;   // yield back to the page, resume next tick
    }
    if (queue.length) setTimeout(drain, 0);
    else draining = false;
  }

  // ── MessagePack decoder ──────────────────────────────────────────────────────
  function decodeMsgPack(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    const dec = new TextDecoder();

    // Bounds guard — throws (→ decode returns null) instead of over-reading or
    // looping forever on non-MessagePack / malformed frames. This is what keeps
    // colonist.io's control frames from freezing the tab.
    const need = k => { if (offset + k > bytes.length) throw new RangeError('overrun'); };
    // A map/array can't contain more entries than there are remaining bytes
    // (each entry needs ≥1 byte), so reject absurd counts before looping.
    const cap  = n => { if (n < 0 || n > bytes.length - offset) throw new RangeError('count'); return n; };

    const rU8  = () => { need(1); return bytes[offset++]; };
    const rU16 = () => { need(2); const v=view.getUint16(offset); offset+=2; return v; };
    const rU32 = () => { need(4); const v=view.getUint32(offset); offset+=4; return v; };
    const rI8  = () => { need(1); const v=view.getInt8(offset);   offset+=1; return v; };
    const rI16 = () => { need(2); const v=view.getInt16(offset);  offset+=2; return v; };
    const rI32 = () => { need(4); const v=view.getInt32(offset);  offset+=4; return v; };
    const rF32 = () => { need(4); const v=view.getFloat32(offset);offset+=4; return v; };
    const rF64 = () => { need(8); const v=view.getFloat64(offset);offset+=8; return v; };
    const rStr = n  => { need(n); const s=dec.decode(bytes.slice(offset,offset+n)); offset+=n; return s; };
    const rBin = n  => { need(n); const s=bytes.slice(offset,offset+n); offset+=n; return s; };
    const rArr = n  => { cap(n); const a=[]; for(let i=0;i<n;i++) a.push(rVal()); return a; };
    const rMap = n  => { cap(n); const o={}; for(let i=0;i<n;i++){const k=rVal();o[k]=rVal();} return o; };
    // ext: 1 type byte + `dataLen` payload bytes. We don't use ext values, just skip them.
    const rExt = dataLen => { need(1 + dataLen); offset += 1 + dataLen; return null; };

    function rVal() {
      const b = rU8();
      if ((b&0x80)===0) return b;           // positive fixint
      if ((b&0xf0)===0x80) return rMap(b&0x0f); // fixmap
      if ((b&0xf0)===0x90) return rArr(b&0x0f); // fixarray
      if ((b&0xe0)===0xa0) return rStr(b&0x1f); // fixstr
      if ((b&0xe0)===0xe0) return b-256;         // negative fixint
      switch(b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xca: return rF32();
        case 0xcb: return rF64();
        case 0xcc: return rU8();
        case 0xcd: return rU16();
        case 0xce: return rU32();
        // uint64 / int64 — return as Number (never BigInt: BigInt breaks JSON.stringify).
        // Precision beyond 2^53 is irrelevant for our fields (timestamps etc.), but the
        // offset MUST advance 8 bytes or every field after it decodes as garbage.
        case 0xcf: { need(8); const v = Number(view.getBigUint64(offset)); offset += 8; return v; }
        case 0xd0: return rI8();
        case 0xd1: return rI16();
        case 0xd2: return rI32();
        case 0xd3: { need(8); const v = Number(view.getBigInt64(offset)); offset += 8; return v; }
        case 0xd9: return rStr(rU8());
        case 0xda: return rStr(rU16());
        case 0xdb: return rStr(rU32());
        case 0xc4: return rBin(rU8());
        case 0xc5: return rBin(rU16());
        case 0xc6: return rBin(rU32());
        case 0xdc: return rArr(rU16());
        case 0xdd: return rArr(rU32());
        case 0xde: return rMap(rU16());
        case 0xdf: return rMap(rU32());
        // ext / fixext — read (and skip) type byte + payload so offset stays aligned
        case 0xd4: return rExt(1);
        case 0xd5: return rExt(2);
        case 0xd6: return rExt(4);
        case 0xd7: return rExt(8);
        case 0xd8: return rExt(16);
        case 0xc7: return rExt(rU8());
        case 0xc8: return rExt(rU16());
        case 0xc9: return rExt(rU32());
        default:   return `<0x${b.toString(16)}>`;
      }
    }
    try { return rVal(); } catch(e) { return null; }
  }

  // ── Raw bytes → base64 (for offline re-decode / byte-layout inspection) ───────
  function toB64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    try { return btoa(s); } catch (e) { return null; }
  }

  // ── Binary handler ───────────────────────────────────────────────────────────
  function decodeBinary(buf, direction, url) {
    const bytes = new Uint8Array(buf);
    const firstByte = bytes[0];

    // Try MessagePack decode
    let decoded = null;
    try { decoded = decodeMsgPack(buf); } catch(e) {}

    // Skip heartbeats (id 136, 33B) — they flood the message queue and freeze the tab
    const msgId = decoded && (decoded.id || (decoded.data && decoded.id));
    const isHeartbeat = bytes.length <= 36 && (msgId === '136' || msgId === 136 ||
      (decoded && decoded.data && typeof decoded.data.timestamp !== 'undefined' && Object.keys(decoded.data).length === 1));
    if (isHeartbeat) return;

    // Cheap ascii preview — only the first 120 bytes, never the whole frame.
    const N = Math.min(bytes.length, 120);
    let ascii = '';
    for (let i = 0; i < N; i++) { const b = bytes[i]; ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.'; }

    // Only keep raw base64 bytes for frames that FAILED to decode (rare — worth inspecting).
    // Everything else has a full decoded tree already; carrying b64 on every small frame doubled
    // the payload relayed + stored on EVERY message and was pure overhead → dropped for stability.
    const b64 = (decoded === null) ? toB64(bytes) : undefined;

    const msg = {
      direction, type: 'binary',
      byteLength: bytes.length,
      firstByte: '0x'+firstByte.toString(16),
      decoded,
      ascii,
      b64
    };

    window.dispatchEvent(new CustomEvent('catan_raw_message', { detail: { ...msg, url } }));

    // Classify and emit game event
    const gameEvent = classifyDecoded(decoded, msg);
    if (gameEvent) {
      window.dispatchEvent(new CustomEvent('catan_game_event', { detail: gameEvent }));
    }
  }

  // ── Classify decoded MessagePack ─────────────────────────────────────────────
  function classifyDecoded(decoded, raw) {
    if (!decoded) return { category: 'UNKNOWN_BINARY', ...raw };

    // The keyword scan below stringifies the whole decoded tree — only affordable
    // for small frames. Big frames (game-state snapshots) are classified via their
    // structured fields (gameLogState / diceState / playerStates / currentState),
    // which are checked before any `str` use, so an empty scan string is harmless.
    const big = raw && typeof raw.byteLength === 'number' && raw.byteLength > 2500;
    const str = big ? '' : JSON.stringify(decoded).toLowerCase();

    // colonist.io uses two structures:
    // Binary id 130: { id, type, payload: { diff: { diceState, currentState, ... } } }
    // Text/heartbeat: { id, data: { type, payload: { ... } } }
    const type = decoded.type || decoded.id || '';
    // Prefer decoded.payload directly (id 130 binary), fall back to decoded.data.payload (text msgs)
    const dataObj = decoded.data && decoded.data.payload ? decoded.data : decoded;
    const payload = dataObj.payload || decoded.payload || dataObj;
    const diff = (payload && payload.diff) || {};

    const addGameState = payload.addGameState || {};

    // ── Dice PRIMARY: gameLogState type=10 fires exactly once per roll — most reliable
    if (diff.gameLogState) {
      for (const entry of Object.values(diff.gameLogState)) {
        if (entry && entry.text && entry.text.type === 10) {
          const d1 = entry.text.firstDice, d2 = entry.text.secondDice;
          if (typeof d1 === 'number' && typeof d2 === 'number') {
            const total = d1 + d2;
            if (total >= 2 && total <= 12) {
              const diceState = diff.diceState || addGameState.diceState ||
                { dice1: d1, dice2: d2, diceThrown: true };
              return { category: 'DICE', total, diceState, decoded, ...raw };
            }
          }
        }
      }
    }

    // ── Dice SECONDARY: diceState (diceThrown===true OR diceThrown not present but dice values valid)
    if (diff.diceState || addGameState.diceState) {
      const diceState = diff.diceState || addGameState.diceState || {};
      const thrown = diceState.diceThrown;
      // Accept: diceThrown===true, OR diceThrown is absent/undefined (some message variants omit it)
      // Reject: diceThrown===false (explicit reset means no roll happened this message)
      if (thrown !== false &&
          typeof diceState.dice1 === 'number' && typeof diceState.dice2 === 'number' &&
          diceState.dice1 >= 1 && diceState.dice2 >= 1) {
        const total = diceState.dice1 + diceState.dice2;
        if (total >= 2 && total <= 12) {
          return { category: 'DICE', total, diceState, decoded, ...raw };
        }
      }
    }

    // ── Player states — exact card counts (check both diff and addGameState)
    const psData = diff.playerStates ||
      (payload.addGameState && payload.addGameState.playerStates);
    if (psData) {
      return { category: 'PLAYER_STATES', playerStates: psData, decoded, ...raw };
    }

    // Turn state
    if (diff.currentState || str.includes('turnstate') || str.includes('currentstate')) {
      return { category: 'TURN_STATE', diff, decoded, ...raw };
    }

    // Building
    if (str.includes('settlement') || str.includes('city') || str.includes('road') || str.includes('build')) {
      return { category: 'BUILD', decoded, ...raw };
    }

    // Resources / cards
    if (str.includes('resource') || str.includes('cards') || str.includes('hand')) {
      return { category: 'RESOURCE', decoded, ...raw };
    }

    // Robber / steal
    if (str.includes('robber') || str.includes('steal')) {
      return { category: 'ROBBER', decoded, ...raw };
    }

    // Card transfer — givingPlayer + givingCards (trades, steals, robber)
    if (str.includes('givingplayer') || str.includes('givingcards')) {
      const p = payload.givingPlayer !== undefined ? payload : (diff.givingPlayer !== undefined ? diff : {});
      return { category: 'CARD_TRANSFER', givingPlayer: p.givingPlayer, givingCards: p.givingCards, receivingPlayer: p.receivingPlayer, receivingCards: p.receivingCards, decoded, ...raw };
    }

    // Trade
    if (str.includes('trade') || str.includes('bank')) {
      return { category: 'TRADE', decoded, ...raw };
    }

    return { category: 'UNKNOWN', decoded, ...raw };
  }

  // ── Frame processor (runs off the WebSocket callback, via the drain queue) ────
  function processRawMessage(data, direction, url) {
    if (!data) return;
    if (data instanceof ArrayBuffer) { decodeBinary(data, direction, url); return; }
    if (data instanceof Blob) { data.arrayBuffer().then(b=>decodeBinary(b,direction,url)).catch(()=>{}); return; }
    if (typeof data === 'string') {
      if (['2','3','40','41'].includes(data)) return;
      let parsed = null;
      const sio = data.match(/^(\d+)(\[[\s\S]*\]|\{[\s\S]*\})?$/);
      if (sio && sio[2]) {
        try {
          const arr = JSON.parse(sio[2]);
          parsed = Array.isArray(arr)
            ? { type:'socketio', event:arr[0], data:arr[1], raw:data, direction }
            : { type:'json', data:arr, raw:data, direction };
        } catch(e) { parsed = { type:'raw', data, raw:data, direction }; }
      } else {
        try { parsed = { type:'json', data:JSON.parse(data), raw:data, direction }; }
        catch(e) { parsed = { type:'raw', data, raw:data, direction }; }
      }
      if (parsed) {
        window.dispatchEvent(new CustomEvent('catan_raw_message', { detail:{ ...parsed, url } }));
        const ev = classifyDecoded(parsed.data, parsed);
        if (ev) window.dispatchEvent(new CustomEvent('catan_game_event', { detail: ev }));
      }
    }
  }

  console.log('[CatanExt] Ready with MessagePack decoder ✓');
})();
