// Ordnerstruktur einlesen und aktuell halten (Datenformat.md, Abschnitt 10).
// Beim ersten Mal wird der ganze Ablageordner gelesen, danach fragt die App OneDrive nur noch nach Änderungen
// (delta). Das Ergebnis liegt im Browser (IndexedDB, Schlüssel "tree"), damit die App sofort etwas zeigt.

import { applyDelta } from './library.js';
import { ResyncError } from './onedrive.js';
import * as store from './store.js';

/**
 * Sucht den Ablageordner. Der Bilder-Ordner heisst je nach Konto "Pictures" oder "Bilder":
 * zuerst über den OneDrive-Spezialordner "photos", dann beide Namen ausprobieren.
 * Ergebnis: { path, id } oder null (gibt es noch nicht).
 */
export async function findRoot(drive, folderName = 'LifePhotoBook') {
  const tried = new Set();
  const special = await drive.specialFolder('photos').catch(() => null);
  for (const base of [special?.name, 'Pictures', 'Bilder']) {
    if (!base || tried.has(base)) continue;
    tried.add(base);
    const path = `${base}/${folderName}`;
    const id = await drive.itemIdByPath(path);
    if (id) return { path, id };
  }
  return null;
}

/**
 * Bringt den gemerkten Stand auf den neusten Stand.
 * root: { path, id }; full = true: alles neu einlesen.
 * onProgress(anzahl) während des Lesens. Ergebnis: { items: Map, changed: Anzahl Änderungen, scannedAt }
 */
export async function refresh(drive, root, { full = false, onProgress = () => {} } = {}) {
  let saved = await store.loadTree();
  if (full || !saved || saved.rootId !== root.id || !saved.deltaLink) saved = null;
  const items = new Map((saved?.items ?? []).map((i) => [i.id, i]));
  let result;
  try {
    result = await drive.delta(root.id, saved?.deltaLink ?? null, onProgress);
  } catch (e) {
    if (!(e instanceof ResyncError) || !saved) throw e;
    // Gemerkter Stand zu alt: alles neu
    return refresh(drive, root, { full: true, onProgress });
  }
  applyDelta(items, result.items);
  const tree = { rootId: root.id, rootPath: root.path, deltaLink: result.deltaLink, scannedAt: Date.now(), items: [...items.values()] };
  await store.saveTree(tree);
  return { items, changed: result.items.length, scannedAt: tree.scannedAt };
}

/** Gemerkter Stand ohne OneDrive (sofort beim Start, auch offline). */
export async function cached() {
  const t = await store.loadTree();
  return t ? { rootId: t.rootId, rootPath: t.rootPath, scannedAt: t.scannedAt, items: new Map(t.items.map((i) => [i.id, i])) } : null;
}
