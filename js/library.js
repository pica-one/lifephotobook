// Die Ordnerstruktur aus OneDrive als "Bibliothek": Themen, Unterordner, Events, Fotos, Zeitleiste.
// Reine Rechenfunktionen ohne OneDrive-Zugriff (gut testbar). Eingelesen wird in scan.js.
//
// Ein Element (kompakt gespeichert): { id, name, parentId, isFolder, size, taken, modified }
//   taken    = Aufnahmedatum laut OneDrive ("JJJJ-MM-TT") oder null
//   modified = Änderungsdatum der Datei ("JJJJ-MM-TT") oder null

import { dateFromName, isMediaName, isVideoName } from './media.js';

/** Ab dieser Zeitspanne der Fotos gilt ein Ordner automatisch als "laufend" (z. B. Gottekinder/Ladina). */
export const RUNNING_DAYS = 90;

/** Rohes OneDrive-Element (aus delta) → kompakt. */
export function compact(raw) {
  return {
    id: raw.id,
    name: raw.name ?? '',
    parentId: raw.parentReference?.id ?? null,
    isFolder: !!raw.folder,
    size: raw.size ?? 0,
    taken: day(raw.photo?.takenDateTime),
    modified: day(raw.fileSystemInfo?.lastModifiedDateTime),
  };
}

function day(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
}

/** Änderungen (delta) auf die gemerkten Elemente anwenden. items: Map id → Element (wird verändert). */
export function applyDelta(items, rawItems) {
  for (const raw of rawItems) {
    if (!raw?.id) continue;
    if (raw.deleted) items.delete(raw.id);
    else items.set(raw.id, compact(raw));
  }
  return items;
}

/** Kein Event: Ordner, die mit "_" beginnen (Fotobücher, Sicherungen), und "Dokumente"-Ordner. */
export function isExcludedFolder(name) {
  return name.startsWith('_') || name.trim().toLowerCase() === 'dokumente';
}

/** Datum eines Fotos: Aufnahmedatum, sonst aus dem Dateinamen, sonst Änderungsdatum. */
export function mediaDate(item) {
  return item.taken ?? dateFromName(item.name) ?? item.modified ?? null;
}

/**
 * Baut die Bibliothek.
 * details: Map ordnerId → Ordner-Details aus der Daten-Datei ({ dates, status, … } mit { value, changed }), darf leer sein.
 * flags: Map fotoId → { liked, hidden } aus der Daten-Datei. Ausgeblendete Fotos kommen nach node.hidden statt
 * node.media (zählen nirgends mit). Jedes Foto bekommt liked: { value, changed } | null.
 * Ergebnis: { root, byId: Map id → Knoten, events: [Knoten] }
 * Knoten: { id, name, parentId, names (Pfad als Liste, ohne Ablageordner), depth, children, media, hidden, totalMedia,
 *           photoCount, videoCount, range: {start,end}|null, running, sortDate, details }
 */
export function buildLibrary(items, rootId, details = new Map(), flags = new Map()) {
  const kids = new Map();
  for (const it of items.values()) {
    if (!it.parentId || it.id === rootId) continue;
    if (!kids.has(it.parentId)) kids.set(it.parentId, []);
    kids.get(it.parentId).push(it);
  }
  const byId = new Map();
  const events = [];

  function build(item, names) {
    const node = {
      id: item.id,
      name: item.name,
      parentId: item.parentId,
      names,
      depth: names.length,
      children: [],
      media: [],
      hidden: [],
      docs: [],
      docsFolderId: null,
      details: details.get(item.id) ?? null,
    };
    byId.set(node.id, node);
    for (const c of kids.get(item.id) ?? []) {
      if (c.isFolder) {
        if (!isExcludedFolder(c.name)) node.children.push(build(c, [...names, c.name]));
        else if (c.name.trim().toLowerCase() === 'dokumente') {
          node.docsFolderId = c.id;
          node.docs = (kids.get(c.id) ?? []).filter((d) => !d.isFolder && d.size > 0).sort((x, y) => x.name.localeCompare(y.name, 'de'));
        }
      } else if (c.size > 0 && isMediaName(c.name)) {
        const f = flags.get(c.id);
        const m = { ...c, date: mediaDate(c), liked: f?.liked ?? null };
        (f?.hidden?.value === true ? node.hidden : node.media).push(m);
      }
    }
    node.media.sort(byDate);
    node.hidden.sort(byDate);
    node.videoCount = node.media.filter((m) => isVideoName(m.name)).length;
    node.photoCount = node.media.length - node.videoCount;
    node.totalMedia = node.media.length + node.children.reduce((n, c) => n + c.totalMedia, 0);
    describe(node);
    node.children.sort(byChildOrder(node.depth === 0));
    if (node.media.length && node.depth > 0) events.push(node);
    return node;
  }

  const rootItem = items.get(rootId) ?? { id: rootId, name: '', parentId: null };
  const root = build(rootItem, []);
  events.sort(byTimeline);
  return { root, byId, events };
}

/** Zeitraum, "laufend" und das Datum für die Zeitleiste. */
function describe(node) {
  const dates = node.media.map((m) => m.date).filter(Boolean);
  const own = dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
  const set = node.details?.dates?.value ?? null;
  node.range = set ?? own;
  const status = node.details?.status?.value ?? null;
  node.running = status === 'LAUFEND' ? true : status === 'ABGESCHLOSSEN' ? false : !!own && daysBetween(own.start, own.end) > RUNNING_DAYS;
  // Laufende Ordner stehen beim neusten Foto, alle anderen beim Anfang
  node.sortDate = node.running ? (own?.end ?? node.range?.end ?? null) : (node.range?.start ?? null);
  // Ordner ohne eigene Fotos (z. B. Thema): neustes Datum der Unterordner
  if (!node.sortDate && node.children.length) {
    node.sortDate = node.children.map((c) => c.sortDate).filter(Boolean).sort().pop() ?? null;
  }
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function byDate(a, b) {
  return cmp(a.date ?? '', b.date ?? '') || cmp(a.name, b.name);
}

/** Themen alphabetisch, Unterordner neueste zuerst (ohne Datum alphabetisch am Schluss). */
function byChildOrder(alphabetical) {
  return (a, b) => {
    if (!alphabetical) {
      if (a.sortDate && b.sortDate && a.sortDate !== b.sortDate) return a.sortDate < b.sortDate ? 1 : -1;
      if (!!a.sortDate !== !!b.sortDate) return a.sortDate ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'de', { numeric: true });
  };
}

function byTimeline(a, b) {
  return cmp(b.sortDate ?? '', a.sortDate ?? '') || a.name.localeCompare(b.name, 'de', { numeric: true });
}

/** Zeitleiste nach Jahren: [{ year, events }] (neueste zuerst). */
export function timeline(events) {
  const groups = [];
  for (const e of events) {
    const year = e.sortDate ? e.sortDate.slice(0, 4) : 'Ohne Datum';
    if (groups.at(-1)?.year !== year) groups.push({ year, events: [] });
    groups.at(-1).events.push(e);
  }
  return groups;
}

/** Erstes Foto (kein Video) eines Ordners oder seiner Unterordner – für das Titelbild. */
export function coverOf(node) {
  return firstMedia(node, (m) => !isVideoName(m.name)) ?? firstMedia(node, () => true);
}

function firstMedia(node, accept) {
  const own = node.media.find(accept);
  if (own) return own;
  for (const c of node.children) {
    const x = firstMedia(c, accept);
    if (x) return x;
  }
  return null;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
