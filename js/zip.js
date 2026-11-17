// ZIP-Dateien im Browser bauen (Anforderungen Kap. 8). Ohne Komprimierung ("store"): Fotos und Videos sind schon
// gepackt, Komprimieren brächte fast nichts und wäre auf dem Handy langsam. Rein, gut testbar, kein fremder Code.
// Grenzen: jede ZIP-Datei bleibt unter 4 GB (darum wird vorher in Teile aufgeteilt, siehe splitParts).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Prüfsumme CRC-32 (gehört zu jeder Datei im ZIP). */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** "JJJJ-MM-TT" → Datum und Zeit im alten DOS-Format, wie es ZIP verlangt. */
function dosDateTime(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  if (!m) return { date: ((2000 - 1980) << 9) | (1 << 5) | 1, time: 0 }; // 1.1.2000
  const y = Math.min(Math.max(Number(m[1]), 1980), 2107);
  return { date: ((y - 1980) << 9) | (Number(m[2]) << 5) | Number(m[3]), time: 12 << 11 };
}

/**
 * ZIP bauen. files: [{ name, data: Blob, date: "JJJJ-MM-TT" | null }] (Namen dürfen "Ordner/Datei.jpg" sein).
 * Die Dateien werden nur zum Rechnen der Prüfsumme gelesen, der Inhalt bleibt als Blob (spart Speicher).
 * Ergebnis: Blob (application/zip).
 */
export async function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.data.size;
    const crc = await blobCrc(f.data);
    const { date, time } = dosDateTime(f.date);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // Version
    local.setUint16(6, 0x0800, true); // Namen in UTF-8 (Umlaute)
    local.setUint16(8, 0, true); // ohne Komprimierung
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/** Prüfsumme einer Datei in Stücken lesen (nie alles auf einmal im Speicher). */
async function blobCrc(blob) {
  const STEP = 8 * 1024 * 1024;
  let crc = 0;
  for (let pos = 0; pos < blob.size; pos += STEP) {
    crc = crc32(new Uint8Array(await blob.slice(pos, pos + STEP).arrayBuffer()), crc);
  }
  return crc;
}

/**
 * Fotos auf mehrere ZIP-Dateien verteilen, damit keine zu gross wird. items: [{ size, … }] in gewünschter Reihenfolge.
 * Eine einzelne Datei grösser als maxBytes kommt allein in einen Teil. Ergebnis: [[item, …], …].
 */
export function splitParts(items, maxBytes) {
  const out = [];
  let cur = [];
  let sum = 0;
  for (const it of items) {
    const s = it.size ?? 0;
    if (cur.length && sum + s > maxBytes) {
      out.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(it);
    sum += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Namen im ZIP eindeutig machen: "IMG_1.jpg" zweimal → "IMG_1 (2).jpg". */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > n.lastIndexOf('/') ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}
