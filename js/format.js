// Liest und schreibt die Daten-Datei im Datenformat Version 1 (siehe ../Datenformat.md).
// Im Speicher hat ein Dokument dieselbe Form wie die Datei:
//   { savedAt, savedBy, settings: { oneDriveRoot? }, people: [...], folders: [...], photos: [...], photobooks: [...] }
// Felder sind { value, changed }; fehlt ein Feld, ist es undefined.

export const FORMAT = 'lifephotobook-daten';
export const VERSION = 1;

export const STATUS = ['LAUFEND', 'ABGESCHLOSSEN'];
export const NAME_FORMATS = ['NAME', 'JAHR_NAME', 'DATUM_NAME', 'JAHR', 'DATUM'];
export const FOLDER_FIELDS = ['path', 'dates', 'place', 'people', 'rating', 'notes', 'status', 'nameFormat'];
export const PHOTO_FIELDS = ['liked', 'hidden'];
export const PHOTOBOOK_FIELDS = ['name', 'config', 'saved'];

/** Verständlicher Fehler beim Lesen der Daten-Datei. */
export class FormatError extends Error {}

export function emptyDocument() {
  return { savedAt: 0, savedBy: null, settings: {}, people: [], folders: [], photos: [], photobooks: [] };
}

export function encode(doc) {
  const settings = {};
  if (doc.settings.oneDriveRoot) settings.oneDriveRoot = stamped(doc.settings.oneDriveRoot);
  const root = {
    format: FORMAT,
    version: VERSION,
    savedAt: doc.savedAt,
    ...(doc.savedBy != null ? { savedBy: doc.savedBy } : {}),
    settings,
    people: doc.people.map((p) => ({ name: p.name, favorite: stamped(p.favorite) })),
    folders: doc.folders.map((f) => withFields({ id: f.id, created: f.created }, f, FOLDER_FIELDS)),
    photos: doc.photos.map((p) => withFields({ id: p.id }, p, PHOTO_FIELDS)),
    photobooks: doc.photobooks.map((b) =>
      b.deleted != null ? { id: b.id, created: b.created, deleted: b.deleted } : withFields({ id: b.id, created: b.created, deleted: null }, b, PHOTOBOOK_FIELDS),
    ),
  };
  return JSON.stringify(root, null, 1);
}

function stamped(s) {
  return { value: s.value ?? null, changed: s.changed };
}

function withFields(o, src, fields) {
  for (const f of fields) if (src[f]) o[f] = stamped(src[f]);
  return o;
}

/** Liest die Daten-Datei. Wirft FormatError mit verständlicher Meldung. */
export function decode(fileText) {
  let root;
  try {
    root = JSON.parse(String(fileText).trim().replace(/^﻿/, ''));
  } catch {
    throw new FormatError('Die Daten-Datei ist beschädigt.');
  }
  if (!obj(root) || root.format !== FORMAT) throw new FormatError('Die Datei ist keine LifePhotoBook-Daten-Datei.');
  if ((root.version ?? VERSION) > VERSION) {
    throw new FormatError('Die Daten stammen von einer neueren App-Version. Bitte die Web-App neu laden.');
  }
  const settings = {};
  field(obj(root.settings) || {}, 'oneDriveRoot', settings, (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined));

  const people = [];
  for (const p of arr(root.people)) {
    const name = str(p?.name)?.trim();
    const fav = obj(p?.favorite);
    if (!name || !fav) continue;
    people.push({ name, favorite: { value: fav.value === true, changed: num(fav.changed) } });
  }

  const folders = [];
  for (const f of arr(root.folders)) {
    const id = str(f?.id);
    if (!id) continue;
    const folder = { id, created: num(f.created) };
    field(f, 'path', folder, (v) => (typeof v === 'string' ? v : null));
    field(f, 'dates', folder, readDates);
    field(f, 'place', folder, text);
    field(f, 'people', folder, names);
    field(f, 'rating', folder, (v) => Math.min(5, Math.max(0, typeof v === 'number' ? Math.trunc(v) : 0)));
    field(f, 'notes', folder, (v) => (typeof v === 'string' && v.trim() ? v : null));
    field(f, 'status', folder, (v) => (STATUS.includes(v) ? v : null));
    field(f, 'nameFormat', folder, (v) => (NAME_FORMATS.includes(v) ? v : null));
    folders.push(folder);
  }

  const photos = [];
  for (const p of arr(root.photos)) {
    const id = str(p?.id);
    if (!id) continue;
    const photo = { id };
    for (const k of PHOTO_FIELDS) field(p, k, photo, (v) => v === true);
    photos.push(photo);
  }

  const photobooks = [];
  for (const b of arr(root.photobooks)) {
    const id = str(b?.id);
    if (!id) continue;
    const book = { id, created: num(b.created), deleted: b.deleted == null ? null : num(b.deleted) };
    if (book.deleted == null) {
      field(b, 'name', book, text);
      field(b, 'config', book, (v) => (obj(v) ? v : {}));
      field(b, 'saved', book, (v) => (obj(v) && typeof v.path === 'string' ? { path: v.path, at: num(v.at) } : null));
    }
    photobooks.push(book);
  }
  return { savedAt: num(root.savedAt), savedBy: str(root.savedBy), settings, people, folders, photos, photobooks };
}

/** Liest ein Feld { value, changed }; read() gibt undefined zurück, wenn der Wert unbrauchbar ist. */
function field(src, key, target, read) {
  const o = obj(src[key]);
  if (!o) return;
  const value = read(o.value ?? null);
  if (value !== undefined) target[key] = { value, changed: num(o.changed) };
}

function readDates(v) {
  if (v == null) return null;
  if (!obj(v) || !isDate(v.start)) return undefined;
  const end = isDate(v.end) && v.end >= v.start ? v.end : v.start;
  return { start: v.start, end };
}
function text(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function names(v) {
  return Array.isArray(v) ? v.filter((n) => typeof n === 'string').map((n) => n.trim()).filter(Boolean) : [];
}
function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function str(v) {
  return typeof v === 'string' ? v : null;
}
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
