// Vorschaubilder von OneDrive: werden erst geladen, wenn sie auf dem Bildschirm erscheinen.
// OneDrive-Adressen laufen nach einiger Zeit ab – darum nur für diese Sitzung gemerkt (höchstens 50 Minuten).

const MAX_AGE_MS = 50 * 60 * 1000;
/** itemId → { thumb, large, at } (gleiche Form wie im Tourenbuch, der Betrachter braucht sie) */
export const thumbs = new Map();
const folderLoaded = new Map();
const queue = [];
let active = 0;
let observer = null;
let drive = null;

export function initThumbs(oneDrive) {
  drive = oneDrive;
}

function fresh(id) {
  const t = thumbs.get(id);
  return t && Date.now() - t.at < MAX_AGE_MS;
}

/** Alle Vorschaubilder eines Ordners mit einer Anfrage holen (für das Fotoraster). */
export async function loadFolder(folderId) {
  if (Date.now() - (folderLoaded.get(folderId) ?? 0) < MAX_AGE_MS) return;
  folderLoaded.set(folderId, Date.now());
  try {
    for (const item of await drive.listWithThumbnails(folderId)) {
      if (item.thumb) thumbs.set(item.id, { thumb: item.thumb, large: item.large, at: Date.now() });
    }
  } catch (e) {
    folderLoaded.delete(folderId);
    console.warn('Vorschaubilder', e);
  }
}

/** Bilder mit data-item in diesem Bereich füllen, sobald sie sichtbar werden. */
export function fillThumbs(rootEl) {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        show(e.target);
      }
    },
    { rootMargin: '300px' },
  );
  rootEl.querySelectorAll('img[data-item]').forEach((img) => observer.observe(img));
}

function show(img) {
  const id = img.dataset.item;
  if (fresh(id)) {
    img.src = thumbs.get(id).thumb;
    return;
  }
  queue.push(img);
  pump();
}

function pump() {
  while (active < 4 && queue.length) {
    const img = queue.shift();
    if (!img.isConnected) continue;
    active++;
    load(img.dataset.item)
      .then((url) => {
        if (url && img.isConnected) img.src = url;
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function load(id) {
  if (fresh(id)) return thumbs.get(id).thumb;
  try {
    const url = await drive.thumbnailUrl(id, 'c400x400');
    if (url) thumbs.set(id, { thumb: url, large: null, at: Date.now() });
    return url;
  } catch {
    return null; // einzelnes fehlendes Bild: bleibt grau
  }
}
