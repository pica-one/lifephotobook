// Suche und Filter (Anforderungen Kap. 7): Freitext über Ordnername, Ort, Begleitung, Notizen.
// Filter Thema, Jahr, Person, Bewertung, nur Fotos mit Herz – alle kombinierbar.
// Reine Rechenfunktionen (gut testbar), die Darstellung ist in app.js.

import { hasDetails } from './book.js';
import { isLiked, isVideoName } from './media.js';

/** Leere Suche (nichts eingegeben, kein Filter). */
export function emptyQuery() {
  return { text: '', theme: null, year: null, person: null, minRating: 0, likedOnly: false };
}

export function isEmptyQuery(q) {
  return !q.text.trim() && !q.theme && !q.year && !q.person && !q.minRating && !q.likedOnly;
}

/** Klein, ohne Akzente/Umlaut-Punkte, "_" als Leerzeichen: «Zürich» findet man auch mit «zurich». */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/_/g, ' ')
    .toLowerCase();
}

/** Alles, worin der Freitext sucht. */
function searchText(node) {
  const d = node.details;
  return normalize([...node.names, d?.place?.value, ...(d?.people?.value ?? []), d?.notes?.value].filter(Boolean).join(' \n '));
}

/** Kandidaten: Ordner mit eigenen Fotos (Events) und Ordner mit eingegebenen Details. Nie der Ablageordner. */
function candidates(lib) {
  return [...lib.byId.values()].filter((n) => n.depth > 0 && (n.media.length || hasDetails(n.details)));
}

/** Jahre, in denen ein Ordner liegt (bei mehrjährigen/laufenden alle Jahre von Anfang bis Ende). */
export function yearsOf(node) {
  const r = node.range;
  if (!r) return [];
  const a = Number(r.start.slice(0, 4));
  const b = Number(r.end.slice(0, 4));
  const list = [];
  for (let y = a; y <= b; y++) list.push(String(y));
  return list;
}

/** Fotos mit Herz (ohne Videos) eines Ordners. */
export function likedPhotos(node) {
  return node.media.filter((m) => isLiked(m) && !isVideoName(m.name));
}

/**
 * Suchen. Ergebnis: [{ node, liked }] in der Reihenfolge der Zeitleiste (neueste zuerst).
 * liked = Fotos mit Herz in diesem Ordner (nur gefüllt bei likedOnly).
 */
export function search(lib, q) {
  if (!lib) return [];
  const words = normalize(q.text).split(/\s+/).filter(Boolean);
  const person = q.person ? normalize(q.person) : null;
  const out = [];
  for (const node of candidates(lib)) {
    if (q.theme && node.names[0] !== q.theme) continue;
    if (q.year && !yearsOf(node).includes(q.year)) continue;
    if (person && !(node.details?.people?.value ?? []).some((p) => normalize(p) === person)) continue;
    if (q.minRating && (node.details?.rating?.value ?? 0) < q.minRating) continue;
    if (words.length) {
      const t = searchText(node);
      if (!words.every((w) => t.includes(w))) continue;
    }
    let liked = [];
    if (q.likedOnly) {
      liked = likedPhotos(node);
      if (!liked.length) continue;
    }
    out.push({ node, liked });
  }
  return out.sort((a, b) => cmp(b.node.sortDate ?? '', a.node.sortDate ?? '') || a.node.name.localeCompare(b.node.name, 'de', { numeric: true }));
}

/** Auswahl für die Filter-Knöpfe: Themen, Jahre (neueste zuerst), Personen (häufigste zuerst). */
export function filterOptions(lib) {
  if (!lib) return { themes: [], years: [], people: [] };
  const nodes = candidates(lib);
  const themes = lib.root.children.map((c) => c.name);
  const years = [...new Set(nodes.flatMap(yearsOf))].sort().reverse();
  const count = new Map();
  for (const n of nodes) {
    for (const p of n.details?.people?.value ?? []) {
      const key = normalize(p);
      const e = count.get(key) ?? { name: p, n: 0 };
      e.n++;
      count.set(key, e);
    }
  }
  const people = [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'de')).map((e) => e.name);
  return { themes, years, people };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
