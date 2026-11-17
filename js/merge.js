// Führt die eigenen Daten und die Daten-Datei zusammen (Regeln siehe ../Datenformat.md, Abschnitt 9).
// - Eintrag nur auf einer Seite: wird übernommen
// - auf beiden Seiten: pro Feld gewinnt die jüngere Änderung, bei gleicher Zeit die Daten-Datei
// - Fotobuch gelöscht: bleibt gelöscht (frühester Zeitpunkt)

import { FOLDER_FIELDS, PHOTO_FIELDS, PHOTOBOOK_FIELDS } from './format.js';

/** Löschnotizen und leere Foto-Einträge, die älter sind, werden weggelassen (180 Tage). */
export const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export function merge(local, remote) {
  if (!remote) return local;
  const settings = {};
  const root = pick(local.settings.oneDriveRoot, remote.settings.oneDriveRoot);
  if (root) settings.oneDriveRoot = root;
  return {
    savedAt: Math.max(local.savedAt, remote.savedAt),
    savedBy: local.savedBy ?? remote.savedBy,
    settings,
    people: mergePeople(local.people, remote.people),
    folders: mergeById(local.folders, remote.folders, (l, r) => ({
      id: l.id,
      created: minPositive(l.created, r.created),
      ...fields(l, r, FOLDER_FIELDS),
    })),
    photos: mergeById(local.photos, remote.photos, (l, r) => ({ id: l.id, ...fields(l, r, PHOTO_FIELDS) })),
    photobooks: mergeById(local.photobooks, remote.photobooks, (l, r) => {
      const deleted = [l.deleted, r.deleted].filter((d) => d != null);
      const base = { id: l.id, created: minPositive(l.created, r.created), deleted: deleted.length ? Math.min(...deleted) : null };
      return base.deleted != null ? base : { ...base, ...fields(l, r, PHOTOBOOK_FIELDS) };
    }),
  };
}

/** Jüngere Änderung gewinnt; bei gleicher Zeit die Daten-Datei (remote). */
export function pick(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  return local.changed > remote.changed ? local : remote;
}

function fields(l, r, names) {
  const o = {};
  for (const f of names) {
    const v = pick(l[f], r[f]);
    if (v) o[f] = v;
  }
  return o;
}

function mergeById(local, remote, both) {
  const r = new Map(remote.map((x) => [x.id, x]));
  const out = local.map((l) => (r.has(l.id) ? both(l, r.get(l.id)) : l));
  const seen = new Set(local.map((x) => x.id));
  for (const x of remote) if (!seen.has(x.id)) out.push(x);
  return out;
}

function minPositive(a, b) {
  const v = [a, b].filter((x) => x > 0);
  return v.length ? Math.min(...v) : 0;
}

function mergePeople(local, remote) {
  const result = new Map();
  for (const p of [...remote, ...local]) {
    const key = p.name.trim().toLowerCase();
    const other = result.get(key);
    if (!other || p.favorite.changed > other.favorite.changed) result.set(key, p);
  }
  return [...result.values()];
}

/** Lässt alte Löschnotizen und alte leere Foto-Einträge weg. */
export function prune(doc, now) {
  const limit = now - MAX_AGE_MS;
  const emptyAndOld = (p) => PHOTO_FIELDS.every((f) => !p[f] || (p[f].value === false && p[f].changed < limit));
  return {
    ...doc,
    photos: doc.photos.filter((p) => !emptyAndOld(p)),
    photobooks: doc.photobooks.filter((b) => b.deleted == null || b.deleted >= limit),
  };
}

/** Gleicher Inhalt? (savedAt/savedBy und Reihenfolge zählen nicht) */
export function sameContent(a, b) {
  return canonical(a) === canonical(b);
}

function canonical(doc) {
  const byId = (x, y) => cmp(x.id, y.id);
  return stableStringify({
    settings: doc.settings,
    people: [...doc.people].sort((x, y) => cmp(x.name.toLowerCase(), y.name.toLowerCase())),
    folders: [...doc.folders].sort(byId),
    photos: [...doc.photos].sort(byId),
    photobooks: [...doc.photobooks].sort(byId),
  });
}

export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
