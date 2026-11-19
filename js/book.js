// Die eigenen Daten (Daten-Datei-Inhalt) im Speicher: lädt die Kopie im Browser einmal, führt Änderungen der Reihe
// nach aus (nie zwei gleichzeitig) und speichert sie. Bildschirme werden über subscribe() informiert.
// Dazu die Änderungs-Funktionen (rein, gut testbar) – wie tourbook.js im Tourenbuch.

import { FOLDER_FIELDS } from './format.js';
import { stableStringify } from './merge.js';

export function createBook(persist) {
  let doc = null;
  let queue = Promise.resolve();
  const listeners = new Set();

  async function load() {
    if (!doc) doc = await persist.loadDocument();
    return doc;
  }

  /** fn(aktuell) gibt das neue Dokument zurück oder null (keine Änderung). */
  function update(fn) {
    const next = queue.then(async () => {
      const current = await load();
      const changed = fn(current);
      if (changed && changed !== current) {
        doc = changed;
        await persist.saveDocument(doc);
        listeners.forEach((l) => l(doc));
      }
      return doc;
    });
    queue = next.catch(() => {});
    return next;
  }

  return {
    load,
    update,
    current: () => doc,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Details aller Ordner als Map ordnerId → Details (für buildLibrary). */
export function detailsMap(doc) {
  return new Map((doc?.folders ?? []).map((f) => [f.id, f]));
}

/**
 * Details eines Ordners ändern. values: { dates, place, people, rating, notes, status, nameFormat, path } (nur die
 * genannten). Nur Felder, die wirklich anders sind, bekommen eine neue Zeit. Gibt doc zurück, wenn nichts anders ist.
 */
export function setFolderDetails(doc, id, values, now) {
  const old = doc.folders.find((f) => f.id === id);
  const folder = old ? { ...old } : { id, created: now };
  let changed = false;
  for (const f of FOLDER_FIELDS) {
    if (!(f in values)) continue;
    const v = values[f] ?? (f === 'people' ? [] : f === 'rating' ? 0 : null);
    const before = folder[f]?.value ?? (f === 'people' ? [] : f === 'rating' ? 0 : null);
    if (stableStringify(before) === stableStringify(v)) continue;
    folder[f] = { value: v, changed: now };
    changed = true;
  }
  if (!changed) return doc;
  return { ...doc, folders: old ? doc.folders.map((f) => (f.id === id ? folder : f)) : [...doc.folders, folder] };
}

/** Hat ein Ordner eingegebene Details (ausser Pfad und Namensformat)? */
export function hasDetails(details) {
  if (!details) return false;
  return !!(details.dates?.value || details.place?.value || details.people?.value?.length || details.rating?.value ||
    details.notes?.value || details.status?.value);
}

// ---------- Fotos: Herz und Ausblenden ----------

/** Like/Ausblenden aller Fotos als Map fotoId → { liked?, hidden? } (für buildLibrary). */
export function photoFlagsMap(doc) {
  return new Map((doc?.photos ?? []).map((p) => [p.id, p]));
}

/**
 * Herz ('liked') oder Ausblenden ('hidden') für ein oder mehrere Fotos setzen/wegnehmen.
 * Nur Fotos, bei denen sich wirklich etwas ändert, bekommen eine neue Zeit. Nichts anders → gleiches doc.
 */
export function setPhotoFlag(doc, ids, field, value, now) {
  const todo = new Set(ids);
  let changed = false;
  const photos = doc.photos.map((p) => {
    if (!todo.has(p.id)) return p;
    todo.delete(p.id);
    if ((p[field]?.value === true) === value) return p;
    changed = true;
    return { ...p, [field]: { value, changed: now } };
  });
  if (value) {
    for (const id of todo) {
      photos.push({ id, [field]: { value: true, changed: now } });
      changed = true;
    }
  }
  return changed ? { ...doc, photos } : doc;
}

// ---------- Personen (Begleitung) ----------

/** Alle Namen, die schon als Begleitung vorkommen (häufige zuerst). */
export function allPeople(doc) {
  const count = new Map();
  for (const f of doc.folders) {
    for (const n of f.people?.value ?? []) {
      const key = n.toLowerCase();
      const e = count.get(key) ?? { name: n, n: 0 };
      e.n++;
      count.set(key, e);
    }
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'de')).map((e) => e.name);
}

export function setFavorite(doc, name, favorite, now) {
  const key = name.trim().toLowerCase();
  const others = doc.people.filter((p) => p.name.trim().toLowerCase() !== key);
  return { ...doc, people: [...others, { name: name.trim(), favorite: { value: favorite, changed: now } }] };
}

/** Die (höchstens 8) Favoriten, zuletzt markierte zuerst gezählt, alphabetisch. */
export function favorites(doc) {
  return doc.people
    .filter((p) => p.favorite.value)
    .sort((a, b) => b.favorite.changed - a.favorite.changed)
    .slice(0, 8)
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b, 'de'));
}

export function setSetting(doc, key, value, now) {
  if (doc.settings[key]?.value === value) return doc;
  return { ...doc, settings: { ...doc.settings, [key]: { value, changed: now } } };
}

// ---------- Fotobuch-Entwürfe ----------

/** Alle (nicht gelöschten) Fotobuch-Entwürfe, zuletzt geänderte zuerst. */
export function drafts(doc) {
  const last = (b) => Math.max(b.created ?? 0, b.name?.changed ?? 0, b.config?.changed ?? 0, b.saved?.changed ?? 0);
  return (doc?.photobooks ?? []).filter((b) => b.deleted == null).sort((a, b) => last(b) - last(a));
}

/**
 * Entwurf anlegen oder ändern. values: { name?, config?, saved? } (nur die genannten). Nur Felder, die wirklich
 * anders sind, bekommen eine neue Zeit. Gelöschte Entwürfe bleiben gelöscht. Nichts anders → gleiches doc.
 */
export function setDraft(doc, id, values, now) {
  const old = doc.photobooks.find((b) => b.id === id);
  if (old?.deleted != null) return doc;
  const book = old ? { ...old } : { id, created: now, deleted: null };
  let changed = !old;
  for (const f of ['name', 'config', 'saved']) {
    if (!(f in values)) continue;
    const v = values[f] ?? null;
    if (stableStringify(book[f]?.value ?? null) === stableStringify(v)) continue;
    book[f] = { value: v, changed: now };
    changed = true;
  }
  if (!changed) return doc;
  return { ...doc, photobooks: old ? doc.photobooks.map((b) => (b.id === id ? book : b)) : [...doc.photobooks, book] };
}

/** Entwurf löschen (nur der Eintrag in der Daten-Datei; gespeicherte PDFs auf OneDrive bleiben). */
export function deleteDraft(doc, id, now) {
  const old = doc.photobooks.find((b) => b.id === id);
  if (!old || old.deleted != null) return doc;
  return { ...doc, photobooks: doc.photobooks.map((b) => (b.id === id ? { id, created: b.created, deleted: now } : b)) };
}
