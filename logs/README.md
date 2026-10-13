# Capture Logs

This folder is where game capture dumps live for offline protocol analysis.

## How captures are produced
The extension's side panel auto-saves a rolling JSON dump to your **Downloads** folder
(Chrome extensions can't write directly into an arbitrary project folder):

```
Downloads/catan-logs/catan-capture-latest.json   <- overwritten every 20s (always current)
Downloads/catan-logs/catan-capture-<timestamp>.json  <- created when you click "Save Archive"
```

## Workflow
1. Load the unpacked extension in Chrome (`chrome://extensions` → Load unpacked).
2. Open colonist.io, start a game, open the Catan Companion side panel.
3. **Keep the side panel open** for the whole game — capture only runs while it's open.
4. The Debug tab → "Capture Logger" shows live message count + last save time.
5. When the game ends, click **📦 Save Archive** to snapshot a named copy.
6. Tell Claude you're done — it reads `catan-capture-latest.json` (or an archive) from Downloads
   and analyzes the protocol.

## Capture file format (`catan-capture/v1`)
```jsonc
{
  "meta": { "schema", "savedAt", "messageCount", "durationMs", "myPlayerId", "playerIds" },
  "messages": [
    {
      "i": 0,            // sequence index
      "t": 1234,         // ms since capture start
      "dir": "RECV",     // RECV | SEND
      "kind": "binary",  // binary | socketio | json | raw
      "len": 375,        // byte length
      "fb": "0x82",      // first byte
      "dec": { ... },    // full decoded MessagePack / JSON tree
      "ascii": "...",    // first 120 printable chars
      "b64": "..."       // raw bytes, base64 (small/undecodable frames only)
    }
  ]
}
```
