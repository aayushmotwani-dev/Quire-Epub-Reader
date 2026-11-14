// A minimal ZIP writer: entries are stored, not compressed. That suits both
// uses in Quire: backups (EPUBs are already compressed) and the EPUBs made
// from PDFs (the format requires its first entry to be stored anyway).

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export class ZipStore {
  parts = []; central = []; offset = 0
  constructor({ maxBytes = 3.5 * 1024 ** 3, tooLarge = 'That file would be too large.' } = {}) { this.maxBytes = maxBytes; this.tooLarge = tooLarge }
  add(name, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
    const nameBytes = new TextEncoder().encode(name)
    const crc = crc32(bytes)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true)
    head.setUint16(12, 33, true); head.setUint32(14, crc, true); head.setUint32(18, bytes.length, true); head.setUint32(22, bytes.length, true)
    head.setUint16(26, nameBytes.length, true)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true)
    cd.setUint16(14, 33, true); cd.setUint32(16, crc, true); cd.setUint32(20, bytes.length, true); cd.setUint32(24, bytes.length, true)
    cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, this.offset, true)
    this.central.push(cd.buffer, nameBytes)
    this.parts.push(head.buffer, nameBytes, bytes)
    this.offset += 30 + nameBytes.length + bytes.length
    if (this.offset > this.maxBytes) throw new Error(this.tooLarge)
  }
  finish(type = 'application/zip') {
    const size = this.central.reduce((n, p) => n + p.byteLength, 0)
    const end = new DataView(new ArrayBuffer(22))
    const count = this.central.length / 2
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true)
    end.setUint32(12, size, true); end.setUint32(16, this.offset, true)
    return new Blob([...this.parts, ...this.central, end.buffer], { type })
  }
}

