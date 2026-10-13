// Minimal MessagePack decoder sufficient for colonist.io messages
// Based on the msgpack spec: https://msgpack.org/

(function(global) {
  function decode(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;

    function readByte() { return bytes[offset++]; }
    function readUint8() { return bytes[offset++]; }
    function readUint16() { const v = view.getUint16(offset); offset+=2; return v; }
    function readUint32() { const v = view.getUint32(offset); offset+=4; return v; }
    function readInt8()   { const v = view.getInt8(offset);   offset+=1; return v; }
    function readInt16()  { const v = view.getInt16(offset);  offset+=2; return v; }
    function readInt32()  { const v = view.getInt32(offset);  offset+=4; return v; }
    function readFloat32(){ const v = view.getFloat32(offset);offset+=4; return v; }
    function readFloat64(){ const v = view.getFloat64(offset);offset+=8; return v; }

    function readStr(len) {
      const slice = bytes.slice(offset, offset+len);
      offset += len;
      return new TextDecoder().decode(slice);
    }

    function readBin(len) {
      const slice = bytes.slice(offset, offset+len);
      offset += len;
      return slice;
    }

    function readArray(len) {
      const arr = [];
      for (let i=0;i<len;i++) arr.push(readValue());
      return arr;
    }

    function readMap(len) {
      const obj = {};
      for (let i=0;i<len;i++) {
        const key = readValue();
        const val = readValue();
        obj[key] = val;
      }
      return obj;
    }

    function readValue() {
      const b = readByte();

      // positive fixint
      if ((b & 0x80) === 0) return b;
      // fixmap
      if ((b & 0xf0) === 0x80) return readMap(b & 0x0f);
      // fixarray
      if ((b & 0xf0) === 0x90) return readArray(b & 0x0f);
      // fixstr
      if ((b & 0xe0) === 0xa0) return readStr(b & 0x1f);
      // negative fixint
      if ((b & 0xe0) === 0xe0) return b - 256;

      switch(b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xca: return readFloat32();
        case 0xcb: return readFloat64();
        case 0xcc: return readUint8();
        case 0xcd: return readUint16();
        case 0xce: return readUint32();
        case 0xd0: return readInt8();
        case 0xd1: return readInt16();
        case 0xd2: return readInt32();
        case 0xd9: return readStr(readUint8());
        case 0xda: return readStr(readUint16());
        case 0xdb: return readStr(readUint32());
        case 0xc4: return readBin(readUint8());
        case 0xc5: return readBin(readUint16());
        case 0xc6: return readBin(readUint32());
        case 0xdc: return readArray(readUint16());
        case 0xdd: return readArray(readUint32());
        case 0xde: return readMap(readUint16());
        case 0xdf: return readMap(readUint32());
        default: return `<unknown:0x${b.toString(16)}>`;
      }
    }

    try {
      return readValue();
    } catch(e) {
      return null;
    }
  }

  global.MsgPack = { decode };
})(typeof window !== 'undefined' ? window : global);
