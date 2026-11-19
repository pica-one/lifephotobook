// Die Web-App: Start, Einlesen, Abgleich und Bildschirme.
// Routen: #/ Zeitleiste · #/ordner Themen · #/f/<id> Ordner/Event · #/bearbeiten/<id> Details
//         #/neu[/<id>] Neues Event (in Ordner <id>) · #/suche · #/einstellungen

import * as auth from './auth.js';
import { createBook, detailsMap, favorites, allPeople, hasDetails, photoFlagsMap, setFavorite, setPhotoFlag } from './book.js';
import { APP_NAME, CLIENT_ID } from './config.js';
import { renderCreate } from './create.js';
import { renderEdit } from './edit.js';
import { FormatError } from './format.js';
import { icon } from './icons.js';
import { applyDelta, buildLibrary, coverOf, timeline } from './library.js';
import { isImageName, isLiked, isMediaName, isVideoName } from './media.js';
import { cleanFileName } from './naming.js';
import { AuthError, BusyError, ConflictError, createOneDrive, NotEmptyError } from './onedrive.js';
import { cached, findRoot, refresh } from './scan.js';
import * as store from './store.js';
import { createSync } from './sync.js';
import { fillThumbs, initThumbs, loadFolder, thumbs } from './thumbs.js';
import { askConfirm, dateTime, esc, fmtDate, mediaCount, showToast, stars } from './ui.js';
import { createUploader } from './upload.js';
import { cameraRollInfo, openCameraRoll } from './cameraroll.js';
import { emptyQuery, filterOptions, isEmptyQuery, search } from './search.js';
import { createSelection } from './selection.js';
import { openViewer } from './viewer.js';

const APP_VERSION = 'Web 0.5.3';
const REFRESH_THROTTLE_MS = 2 * 60 * 1000;

const root = document.getElementById('app');
const drive = createOneDrive(auth.getToken);
initThumbs(drive);
const book = createBook(store);
const sync = createSync({ store: book, drive });
const uploader = createUploader({
  drive,
  // Was schon im Ordner liegt (auch ausgeblendet) – gleicher Name + gleiche Grösse wird übersprungen
  existing: (folderId) => {
    const node = state.lib?.byId.get(folderId);
    return node ? [...node.media, ...node.hidden] : [];
  },
  onChange: () => renderUploadOnly(),
  onFinished: (n, skipped) => {
    const parts = [];
    if (n) parts.push(n === 1 ? '1 Datei hochgeladen' : `${n} Dateien hochgeladen`);
    if (skipped) parts.push(skipped === 1 ? '1 schon vorhanden, übersprungen' : `${skipped} schon vorhanden, übersprungen`);
    if (parts.length) showToast(parts.join(' · '));
    render();
    if (n) rescan(); // neue Fotos aus OneDrive holen (mit Aufnahmedatum)
  },
});

// Auswahl-Modus (ZIP, Teilen, Herz/Ausblenden für viele Fotos)
const selection = createSelection({ drive, flag: (ids, field, value) => flagPhotos(ids, field, value), onChange: () => render() });

const state = {
  user: null,
  startError: null,
  items: null, // Map id → Element (eingelesene Ordnerstruktur)
  rootId: null,
  rootPath: null,
  lib: null, // buildLibrary(...)
  rootMissing: false,
  scanning: false,
  scanCount: 0,
  syncing: false,
  problem: null, // { text, action? }
  lastScan: 0,
  docUpload: null, // { folderId, done, total, name }
  justCreated: null,
  showHiddenFor: null, // Ordner, bei dem die ausgeblendeten Fotos aufgeklappt sind
  query: emptyQuery(), // Suche (bleibt erhalten, wenn man ein Event öffnet und zurückkommt)
};

// ---------- Start ----------

async function start() {
  // Die stille Anmeldung lädt die Seite kurz unsichtbar in einem Rahmen: dort nichts starten
  if (window.self !== window.top) return;
  applyTheme(localStorage.getItem('lifephotobook-theme') || 'system');
  try {
    state.user = await auth.initAuth();
  } catch (e) {
    console.error(e);
    state.startError = e.message || String(e);
  }
  if (state.user) {
    // Anderes Konto als zuletzt? Dann gehören die gespeicherten Daten nicht dieser Person: zuerst leeren
    const meta = await store.loadMeta();
    const owner = state.user.username.toLowerCase();
    if (meta.owner && meta.owner !== owner) await store.clearAll();
    if (meta.owner !== owner) await store.saveMeta({ owner });
    await book.load();
    // Sofort den gemerkten Stand zeigen, dann bei OneDrive nachfragen
    const c = await cached();
    if (c) {
      state.items = c.items;
      state.rootId = c.rootId;
      state.rootPath = c.rootPath;
      state.lastScan = c.scannedAt;
      rebuild();
    }
    book.subscribe(() => {
      rebuild();
      render();
    });
  }
  window.addEventListener('hashchange', () => render(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastScan > REFRESH_THROTTLE_MS) {
      rescan();
      syncNow();
    }
  });
  window.addEventListener('online', () => {
    rescan();
    syncNow();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.docUpload || uploader.isRunning()) e.preventDefault();
  });
  render(true);
  if (state.user) {
    rescan();
    syncNow();
  }
}

function rebuild() {
  const doc = book.current();
  state.lib = state.items && state.rootId ? buildLibrary(state.items, state.rootId, detailsMap(doc), photoFlagsMap(doc)) : null;
}

// ---------- Einlesen (Ordner) und Abgleich (Daten-Datei) ----------

async function rescan(full = false) {
  if (!state.user || state.scanning) return;
  if (!navigator.onLine) {
    state.problem = { text: 'Kein Internet – du siehst den zuletzt eingelesenen Stand.' };
    return render();
  }
  state.scanning = true;
  state.scanCount = 0;
  render();
  try {
    const meta = await store.loadMeta();
    let rootInfo = meta.root ?? null;
    // Gemerkten Ablageordner prüfen (könnte umbenannt oder gelöscht sein), sonst suchen
    if (rootInfo && (await drive.itemIdByPath(rootInfo.path)) !== rootInfo.id) rootInfo = null;
    if (!rootInfo) {
      rootInfo = await findRoot(drive);
      await store.saveMeta({ root: rootInfo });
    }
    state.rootMissing = !rootInfo;
    if (rootInfo) {
      const r = await refresh(drive, rootInfo, {
        full,
        onProgress: (n) => {
          state.scanCount = n;
          renderScanLine();
        },
      });
      state.items = r.items;
      state.rootId = rootInfo.id;
      state.rootPath = rootInfo.path;
      state.lastScan = r.scannedAt;
      if (full) showToast('Alles neu eingelesen.');
    } else {
      state.items = null;
      state.rootId = null;
    }
    rebuild();
    if (state.problem && !state.problem.action) state.problem = null;
  } catch (e) {
    showProblem(e, 'Einlesen fehlgeschlagen');
  } finally {
    state.scanning = false;
    render();
  }
}

async function syncNow() {
  if (!state.user || !navigator.onLine) return;
  state.syncing = true;
  try {
    await sync.run();
  } catch (e) {
    showProblem(e, 'Abgleich fehlgeschlagen');
    render();
  } finally {
    state.syncing = false;
  }
}

function showProblem(e, what) {
  console.error(e);
  if (e instanceof AuthError) state.problem = { text: 'Anmeldung abgelaufen.', action: 'relogin' };
  else if (e instanceof FormatError) state.problem = { text: e.message };
  else if (e instanceof BusyError) state.problem = { text: e.message + ' Später nochmals.' };
  else state.problem = { text: `${what}: ${e.message || e}` };
}

/** Ein Ordner wurde in der App angelegt/umbenannt: sofort anzeigen (der nächste Abgleich bestätigt es). */
function applyLocal(raw) {
  if (!state.items) return;
  applyDelta(state.items, [raw]);
  rebuild();
}

/** Ablageordner anlegen (beim allerersten Event): im Bilder-Ordner des Kontos. */
async function ensureRoot() {
  if (state.rootId) return state.rootId;
  const special = await drive.specialFolder('photos');
  if (!special) throw new Error('Bilder-Ordner auf OneDrive nicht gefunden.');
  let raw;
  try {
    raw = await drive.createFolder(special.id, 'LifePhotoBook');
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
  }
  const rootInfo = raw ? { path: `${special.name}/LifePhotoBook`, id: raw.id } : await findRoot(drive);
  await store.saveMeta({ root: rootInfo });
  state.rootMissing = false;
  state.rootId = rootInfo.id;
  state.rootPath = rootInfo.path;
  state.items = new Map([[rootInfo.id, { id: rootInfo.id, name: 'LifePhotoBook', parentId: special.id, isFolder: true, size: 0, taken: null, modified: null }]]);
  rebuild();
  return rootInfo.id;
}

// ---------- Darstellung ----------

let lastRoute = null;
let formOpenFor = null;

function render(routeChanged = false) {
  const route = location.hash.replace(/^#\/?/, '');
  // Suche verlassen: Scroll-Stelle merken, beim Zurückkommen (von einem Treffer) wieder dorthin
  if (lastRoute === 'suche' && route !== 'suche') state.searchScroll = window.scrollY;
  const scrollTo = route === 'suche' && lastRoute !== 'suche' ? (state.searchScroll ?? 0) : 0;
  const moved = routeChanged || route !== lastRoute;
  lastRoute = route;
  if (moved) selection.stop(true); // anderer Bildschirm: Auswahl endet
  if (moved) requestAnimationFrame(() => window.scrollTo(0, scrollTo));
  if (!state.user) return renderWelcome();
  const [screen, id] = route.split('/');
  const target = id ? decodeURIComponent(id) : null;
  // Formulare nicht neu zeichnen, solange sie offen sind (sonst gingen Eingaben verloren)
  if (screen === 'bearbeiten' || screen === 'neu') {
    if (formOpenFor === route && !routeChanged) return;
    formOpenFor = route;
    return screen === 'neu' ? renderNew(target) : renderEditScreen(target);
  }
  formOpenFor = null;
  if (screen === 'einstellungen') renderSettings();
  else if (screen === 'f' && target) renderFolder(target);
  else if (screen === 'ordner') renderFolder(state.lib?.root.id ?? null);
  else if (screen === 'suche') renderSearch();
  else renderTimeline();
  bindActions();
}

function topbar(title, { back = false } = {}) {
  return `<header class="topbar">
    ${back ? `<button class="iconbtn" data-action="back" aria-label="Zurück">${icon('back')}</button>` : '<span style="width:44px"></span>'}
    <h1>${esc(title)}</h1>
    <span>
      <button class="iconbtn${state.scanning ? ' spin' : ''}" data-action="rescan" aria-label="Mit OneDrive abgleichen" ${state.scanning ? 'disabled' : ''}>${icon('sync')}</button>
      <a class="iconbtn" href="#/einstellungen" aria-label="Einstellungen">${icon('settings')}</a>
    </span>
  </header>`;
}

function tabs(active) {
  return `<nav class="tabs">
    <a href="#/" class="${active === 'zeit' ? 'on' : ''}">Zeitleiste</a>
    <a href="#/ordner" class="${active === 'ordner' ? 'on' : ''}">Ordner</a>
    <a href="#/suche" class="${active === 'suche' ? 'on' : ''}">${icon('search', 18)} Suche</a>
  </nav>`;
}

function fab(parentId = null) {
  return `<a class="fab" href="#/neu${parentId ? `/${encodeURIComponent(parentId)}` : ''}">${icon('add')}<span>${parentId ? 'Neuer Ordner' : 'Neues Event'}</span></a>`;
}

function statusLines() {
  let html = '<div id="scanline"></div>';
  const p = state.problem;
  if (p) {
    const btn = p.action === 'relogin' ? '<button class="btn outline" data-action="relogin">Neu anmelden</button>' : '';
    html += `<div class="status error">${esc(p.text)}${btn}</div>`;
  }
  if (state.rootMissing && !state.scanning) {
    html += `<div class="status">In diesem OneDrive gibt es noch keinen Ordner <b>LifePhotoBook</b>.
      Er wird angelegt, sobald du das erste Event erstellst.</div>`;
  }
  return html;
}

function renderScanLine() {
  const box = document.getElementById('scanline');
  if (!box) return;
  box.innerHTML = state.scanning
    ? `<div class="status">${state.lib ? 'Suche nach Änderungen auf OneDrive …' : 'Ordner werden eingelesen …'}${state.scanCount ? ` ${state.scanCount} Dateien` : ''}</div>`
    : '';
}

// --- Zeitleiste ---

function renderTimeline() {
  const lib = state.lib;
  let body;
  if (!lib) body = state.scanning || state.rootMissing ? '' : '<div class="empty">Noch nichts eingelesen.</div>';
  else if (!lib.events.length) body = '<div class="empty">Noch keine Fotos im LifePhotoBook-Ordner.</div>';
  else {
    body = timeline(lib.events)
      .map((g) => `<div class="section"><h2>${esc(g.year)}</h2><div class="cards">${g.events.map((e) => eventCard(e, true)).join('')}</div></div>`)
      .join('');
  }
  root.innerHTML = `${topbar(APP_NAME)}${tabs('zeit')}${statusLines()}${body}${fab()}`;
  renderScanLine();
  fillThumbs(root);
}

/** Karte für ein Event oder einen Ordner. withPath: übergeordnete Ordner anzeigen (in der Zeitleiste). */
function eventCard(node, withPath) {
  const cover = coverOf(node);
  const parents = node.names.slice(0, -1);
  const own = node.media.length;
  const sub = node.totalMedia - own;
  const people = node.details?.people?.value ?? [];
  const place = node.details?.place?.value;
  const rating = node.details?.rating?.value ?? 0;
  return `<a class="card ev" href="#/f/${encodeURIComponent(node.id)}">
    <span class="cover">${cover ? `<img data-item="${esc(cover.id)}" alt="" loading="lazy">` : icon('folder', 32)}</span>
    <div class="body">
      ${withPath && parents.length ? `<div class="path">${esc(parents.map(pretty).join(' › '))}</div>` : ''}
      <div class="name">${esc(pretty(node.name))}${rating ? ` <span class="stars small">${stars(rating)}</span>` : ''}</div>
      ${place || people.length ? `<div class="sub">${esc([place, people.length ? `mit ${people.join(', ')}` : null].filter(Boolean).join(' · '))}</div>` : ''}
      <div class="foot">
        <span>${node.range ? esc(rangeText(node.range, node.running)) : ''}</span>
        <span>${node.running ? '<span class="tag">laufend</span>' : ''}${own ? mediaCount(node.photoCount, node.videoCount) : ''}${
          node.children.length && !withPath ? `${own ? ' · ' : ''}${node.children.length} Ordner${own ? '' : ` · ${sub} Dateien`}` : ''
        }</span>
      </div>
    </div>
  </a>`;
}

/** "2018_Kanada" → "2018 Kanada" (nur zur Anzeige – auf OneDrive bleibt der Name, wie er ist). */
function pretty(name) {
  return name.replace(/_/g, ' ');
}

function rangeText(r, running) {
  if (running) return `${fmtDate(r.start)} – ${fmtDate(r.end)}`;
  if (r.start === r.end) return fmtDate(r.start);
  const [y1, m1, d1] = r.start.split('-');
  const [y2, m2] = r.end.split('-');
  if (y1 === y2 && m1 === m2) return `${d1}.–${fmtDate(r.end)}`;
  if (y1 === y2) return `${d1}.${m1}. – ${fmtDate(r.end)}`;
  return `${fmtDate(r.start)} – ${fmtDate(r.end)}`;
}

// --- Suche und Filter ---

const RATINGS = [[3, '★★★ und mehr'], [4, '★★★★ und mehr'], [5, '★★★★★']];

function renderSearch() {
  const q = state.query;
  // Neu zeichnen während des Tippens (z. B. Abgleich fertig): Eingabefeld behält Fokus und Cursor
  const typing = document.activeElement?.id === 'search' ? document.activeElement.selectionStart : null;
  const o = filterOptions(state.lib);
  const chipRow = (label, key, values, show = (v) => v) =>
    values.length
      ? `<div class="filter"><div class="filterlabel">${label}</div><div class="chips">${values
          .map((v) => `<button class="chip${q[key] === v ? ' on' : ''}" data-filter="${key}" data-value="${esc(String(v))}" aria-pressed="${q[key] === v}">${esc(show(v))}</button>`)
          .join('')}</div></div>`
      : '';
  root.innerHTML = `
    ${topbar(APP_NAME)}${tabs('suche')}${statusLines()}
    <label class="search">${icon('search', 20)}<input id="search" type="search" placeholder="Ort, Name, Person, Notizen …" value="${esc(q.text)}" aria-label="Suchen" autocomplete="off"></label>
    <div class="filters">
      <div class="filter"><div class="chips">
        <button class="chip${q.likedOnly ? ' on' : ''}" data-liked aria-pressed="${q.likedOnly}">♥ Nur Fotos mit Herz</button>
        <button class="chip clear" data-clear ${isEmptyQuery(q) ? 'hidden' : ''}>${icon('close', 16)} Alles zurücksetzen</button>
      </div></div>
      ${chipRow('Thema', 'theme', o.themes, pretty)}
      ${chipRow('Jahr', 'year', o.years)}
      ${chipRow('Person', 'person', o.people)}
      ${o.themes.length ? chipRow('Bewertung', 'minRating', RATINGS.map(([n]) => n), (n) => RATINGS.find(([m]) => m === n)[1]) : ''}
    </div>
    <div id="results"></div>`;
  renderScanLine();
  drawResults();
  const input = root.querySelector('#search');
  if (typing != null) {
    input.focus();
    input.setSelectionRange(typing, typing);
  }
  input.oninput = () => {
    q.text = input.value;
    drawResults();
  };
  // «Enter» auf dem Handy: Tastatur schliessen, damit man die Treffer sieht
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
  };
  root.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.filter;
      const v = key === 'minRating' ? Number(b.dataset.value) : b.dataset.value;
      q[key] = q[key] === v ? emptyQuery()[key] : v; // nochmals antippen = Filter weg
      render();
    };
  });
  root.querySelector('[data-liked]').onclick = () => {
    q.likedOnly = !q.likedOnly;
    render();
  };
  root.querySelector('[data-clear]')?.addEventListener('click', () => {
    state.query = emptyQuery();
    render();
  });
}

/** Nur die Treffer neu zeichnen (beim Tippen – das Eingabefeld bleibt, wie es ist). */
function drawResults() {
  const box = root.querySelector('#results');
  if (!box) return;
  const q = state.query;
  const lib = state.lib;
  // «Alles zurücksetzen» auch beim Tippen ein-/ausblenden
  const clear = root.querySelector('[data-clear]');
  if (clear) clear.hidden = isEmptyQuery(q);
  if (!lib) {
    box.innerHTML = state.scanning ? '' : '<div class="empty">Noch nichts eingelesen.</div>';
    return;
  }
  const hits = search(lib, q);
  if (!hits.length) {
    box.innerHTML = `<div class="empty">${q.likedOnly ? 'Keine Fotos mit Herz gefunden.' : 'Nichts gefunden.'}${isEmptyQuery(q) ? '' : '<br>Andere Wörter versuchen oder Filter wegnehmen.'}</div>`;
    return;
  }
  if (q.likedOnly) {
    // Fotos mit Herz: pro Event eine Überschrift und das Raster; der Betrachter blättert durch alle Treffer
    const all = hits.flatMap((h) => h.liked);
    let i = 0;
    const folderOf = new Map(hits.flatMap((h) => h.liked.map((m) => [m.id, pretty(h.node.name)])));
    box.innerHTML = `<div class="row between countrow"><p class="count">${all.length === 1 ? '1 Foto' : `${all.length} Fotos`} mit Herz in ${hits.length === 1 ? '1 Event' : `${hits.length} Events`}</p>${selectButton('suche')}</div>
      ${hits.map((h) => `<div class="section">
        <a class="hitlink" href="#/f/${encodeURIComponent(h.node.id)}">${h.node.names.length > 1 ? `<span class="muted">${esc(h.node.names.slice(0, -1).map(pretty).join(' › '))} › </span>` : ''}${esc(pretty(h.node.name))}</a>
        <div class="grid">${grid(h.liked, 'data-hit', false, (i += h.liked.length) - h.liked.length)}</div>
      </div>`).join('')}`;
    box.querySelectorAll('[data-hit]').forEach((b) => {
      b.onclick = () =>
        openViewer({
          photos: toViewer(all),
          start: Number(b.dataset.hit),
          drive,
          thumbs,
          onLike: (p, liked) => flagPhotos([p.id], 'liked', liked),
          onRemove: (p) => flagPhotos([p.id], 'hidden', true),
        });
    });
    box.querySelector('[data-select-on]')?.addEventListener('click', () => selection.start('suche'));
    box.querySelector('[data-select-off]')?.addEventListener('click', () => selection.stop());
    selection.mount(box, 'suche', { cells: '[data-hit]', attr: 'data-hit', items: all, folderOf: (m) => folderOf.get(m.id), name: 'Fotos mit Herz' });
  } else {
    selection.stop(true);
    box.innerHTML = `${isEmptyQuery(q) ? '' : `<p class="count">${hits.length === 1 ? '1 Treffer' : `${hits.length} Treffer`}</p>`}
      <div class="section"><div class="cards">${hits.map((h) => eventCard(h.node, true)).join('')}</div></div>`;
  }
  fillThumbs(box);
}

// --- Ordner / Event ---

function renderFolder(id) {
  const lib = state.lib;
  const node = id ? lib?.byId.get(id) : null;
  if (!node) {
    root.innerHTML = `${topbar(APP_NAME)}${tabs('ordner')}${statusLines()}${
      state.scanning ? '' : lib ? '<div class="empty">Diesen Ordner gibt es nicht mehr.</div>' : ''
    }${fab()}`;
    renderScanLine();
    return;
  }
  const isRoot = node.depth === 0;
  const crumbs = isRoot
    ? ''
    : `<nav class="crumbs"><a href="#/ordner">Themen</a>${ancestors(node)
        .map((a) => ` › <a href="#/f/${encodeURIComponent(a.id)}">${esc(pretty(a.name))}</a>`)
        .join('')}</nav>`;
  const media = node.media;
  const fresh = state.justCreated === node.id;
  state.justCreated = null;
  root.innerHTML = `
    ${topbar(isRoot ? APP_NAME : pretty(node.name), { back: !isRoot })}
    ${isRoot ? tabs('ordner') : crumbs}
    ${statusLines()}
    ${fresh ? `<div class="status ok">Ordner auf OneDrive angelegt. Details, Fotos und Dokumente kannst du jetzt oder später hinzufügen.</div>` : ''}
    ${isRoot ? '' : detailsSection(node)}
    ${node.children.length ? `<div class="section">${isRoot ? '' : `<h2>Ordner <span class="muted">(${node.children.length})</span></h2>`}
      <div class="cards">${node.children.map((c) => eventCard(c, false)).join('')}</div></div>` : ''}
    ${media.length || !isRoot ? mediaSection(node, isRoot) : ''}
    ${node.hidden.length ? hiddenSection(node) : ''}
    ${isRoot ? '' : docsSection(node)}
    ${isEmptyFolder(node) ? `<div class="section"><button class="btn outline small danger" data-delete-folder>${icon('delete', 18)} Leeren Ordner löschen</button>
      <p class="muted small">Falsch angelegt? Ein leerer Ordner (ohne Fotos, Dokumente und Unterordner) darf weg.</p></div>` : ''}
    ${selection.active(`f:${node.id}`) ? '' : fab(isRoot ? null : node.id)}`;
  root.querySelector('[data-delete-folder]')?.addEventListener('click', () => deleteFolder(node));
  renderScanLine();
  root.querySelectorAll('[data-photo]').forEach((b) => {
    b.onclick = () =>
      openViewer({
        photos: toViewer(media),
        start: Number(b.dataset.photo),
        drive,
        thumbs,
        onLike: (p, liked) => flagPhotos([p.id], 'liked', liked),
        onRemove: (p) => flagPhotos([p.id], 'hidden', true),
      });
  });
  root.querySelectorAll('[data-hidden-photo]').forEach((b) => {
    b.onclick = () =>
      openViewer({
        photos: toViewer(node.hidden),
        start: Number(b.dataset.hiddenPhoto),
        drive,
        thumbs,
        onRestore: (p) => flagPhotos([p.id], 'hidden', false),
      });
  });
  root.querySelector('[data-toggle-hidden]')?.addEventListener('click', () => {
    state.showHiddenFor = state.showHiddenFor === node.id ? null : node.id;
    render();
  });
  root.querySelector('[data-like-all]')?.addEventListener('click', async (e) => {
    const liked = e.currentTarget.dataset.likeAll === 'on';
    const stills = media.filter((m) => !isVideoName(m.name));
    if (!liked && !(await askConfirm(`Bei allen ${stills.filter((m) => isLiked(m)).length} Fotos in «${pretty(node.name)}» das Herz entfernen?`, { ok: 'Herzen entfernen' }))) return;
    await flagPhotos(stills.map((m) => m.id), 'liked', liked);
  });
  root.querySelector('[data-add-media]')?.addEventListener('click', () => pickMedia(node));
  bindCameraRoll(node);
  bindSelectButtons();
  selection.mount(root, `f:${node.id}`, { cells: '[data-photo]', attr: 'data-photo', items: media, folderOf: () => pretty(node.name), name: pretty(node.name) });
  root.querySelector('[data-retry]')?.addEventListener('click', () => uploader.retryFailed());
  bindDocs(node);
  // Fotoraster: alle Vorschaubilder des Ordners auf einmal, Unterordner-Titelbilder einzeln
  if (media.length) loadFolder(node.id).then(() => fillThumbs(root));
  else fillThumbs(root);
}

// --- Fotos: Raster, Herz, Ausblenden, Hochladen ---

function mediaSection(node, isRoot) {
  const media = node.media;
  const stills = media.filter((m) => !isVideoName(m.name));
  const likedCount = stills.filter((m) => isLiked(m)).length;
  const allLiked = stills.length > 0 && likedCount === stills.length;
  return `<div class="section">
    <div class="sectionhead"><h2>${node.videoCount ? 'Fotos und Videos' : 'Fotos'}${media.length ? ` <span class="muted">(${mediaCount(node.photoCount, node.videoCount)})</span>` : ''}</h2>
      ${selection.active(`f:${node.id}`) ? `<span class="row nowrap">${selectButton(`f:${node.id}`)}</span>` : ''}</div>
    ${selection.active(`f:${node.id}`) ? '<p class="muted small">Fotos antippen zum Auswählen. Unten: als ZIP herunterladen, teilen, Herz, ausblenden.</p>' : mediaButtons(node, isRoot, stills.length > 1, allLiked)}
    <div id="uploadstatus">${uploadStatus(node.id)}</div>
    ${media.length ? grid(media, 'data-photo') : '<p class="muted small">Noch keine Fotos.</p>'}
  </div>`;
}

/**
 * Kleine Knöpfe 2×2 (wie Tourenbuch): «+ Aus Galerie», «+ Aus OneDrive App» (nur wenn es den Ordner der
 * OneDrive-App gibt – sonst heisst der erste «+ Fotos/Videos»), «♥ Alle liken», «Auswählen».
 */
function mediaButtons(node, isRoot, canLike, allLiked) {
  const buttons = [];
  if (!isRoot) {
    buttons.push(`<button class="btn outline mediaBtn" data-add-media>${icon('add', 16)} <span data-gallery-label>Fotos/Videos</span></button>`);
    buttons.push(`<button class="btn outline mediaBtn" data-camera-roll hidden>${icon('add', 16)} Aus OneDrive App</button>`);
  }
  if (canLike) buttons.push(`<button class="btn outline mediaBtn" data-like-all="${allLiked ? 'off' : 'on'}">${allLiked ? '♡ Herzen entfernen' : '♥ Alle liken'}</button>`);
  if (node.media.length) buttons.push(`<button class="btn outline mediaBtn" data-select-on="${esc(`f:${node.id}`)}">${icon('check', 16)} Auswählen</button>`);
  return buttons.length ? `<div class="mediaBtns">${buttons.join('')}</div>` : '';
}

/** Knopf «Auswählen» bzw. «Fertig» (Auswahl-Modus ein/aus). */
function selectButton(scope) {
  return selection.active(scope)
    ? `<button class="btn small" data-select-off>Fertig</button>`
    : `<button class="btn outline small" data-select-on="${esc(scope)}">${icon('check', 18)} Auswählen</button>`;
}

function bindSelectButtons() {
  root.querySelector('[data-select-on]')?.addEventListener('click', (e) => selection.start(e.currentTarget.dataset.selectOn));
  root.querySelector('[data-select-off]')?.addEventListener('click', () => selection.stop());
}

function hiddenSection(node) {
  const open = state.showHiddenFor === node.id;
  return `<div class="section">
    <button class="linkbtn" data-toggle-hidden>${open ? 'Ausgeblendete Fotos verbergen' : `Ausgeblendete Fotos anzeigen (${node.hidden.length})`}</button>
    ${open ? `<p class="muted small">Diese Fotos sind nur in der App ausgeblendet, auf OneDrive sind sie noch da. Antippen → «Wieder einblenden».</p>
      <div class="grid dim">${grid(node.hidden, 'data-hidden-photo', false)}</div>` : ''}
  </div>`;
}

function grid(list, attr, withGridDiv = true, offset = 0) {
  const cells = list
    .map((m, j) => {
      const i = j + offset;
      const video = isVideoName(m.name);
      const liked = isLiked(m);
      return `<button class="cell${video ? ' video' : ''}" ${attr}="${i}" aria-label="${esc(m.name)}${video ? ' (Video)' : ''}${liked ? ' (gefällt mir)' : ''}"><img data-item="${esc(m.id)}" alt="" loading="lazy">${video ? '<span class="play" aria-hidden="true">▶</span>' : ''}${liked ? '<span class="heart" aria-hidden="true">♥</span>' : ''}</button>`;
    })
    .join('');
  return withGridDiv ? `<div class="grid">${cells}</div>` : cells;
}

function toViewer(list) {
  return list.map((m) => ({ id: m.id, fileName: m.name, oneDriveItemId: m.id, liked: m.liked, size: m.size }));
}

/** Herz oder Ausblenden speichern (im Browser sofort, Daten-Datei kurz danach). */
async function flagPhotos(ids, field, value) {
  await book.update((d) => setPhotoFlag(d, ids, field, value, Date.now()));
  syncSoon();
}

let syncTimer = null;
/** Viele schnelle Änderungen (z. B. Herzen) → nur ein Abgleich, kurz nach der letzten. */
function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 2000);
}

function uploadStatus(folderId) {
  const s = uploader.status();
  const failed = s.failed.filter((f) => f.folderId === folderId);
  let html = '';
  const here = s.active.filter((a) => a.folderId === folderId);
  if (here.length) {
    const pct = Math.round((here.reduce((n, a) => n + (a.progress ?? 0), 0) / here.length) * 100);
    const names = here.length === 1 ? esc(here[0].name) : `${here.length} Dateien gleichzeitig`;
    const done = s.uploaded ? ` · ${s.uploaded} fertig` : '';
    const verb = here.every((a) => a.copy) ? 'Kopiere' : 'Lade hoch';
    html += `<div class="upload"><div class="uploadtext">${verb}: ${names} (${pct} %)${s.waiting ? ` · noch ${s.waiting} wartend` : ''}${done}</div>
      <div class="bar"><span style="width:${pct}%"></span></div></div>`;
  }
  if (failed.length) {
    html += `<div class="upload error">${failed.length === 1 ? '1 Datei wurde' : `${failed.length} Dateien wurden`} nicht hochgeladen: ${esc(failed[0].reason)}
      <button class="btn outline small" data-retry>Nochmals versuchen</button></div>`;
  }
  return html;
}

/** Nur den Fortschritt neu zeichnen (wird beim Hochladen sehr oft aufgerufen). */
let uploadDrawPending = false;
function renderUploadOnly() {
  if (uploadDrawPending) return;
  uploadDrawPending = true;
  requestAnimationFrame(() => {
    uploadDrawPending = false;
    const box = root.querySelector('#uploadstatus');
    const id = location.hash.startsWith('#/f/') ? decodeURIComponent(location.hash.slice(4)) : null;
    if (!box || !id) return;
    box.innerHTML = uploadStatus(id);
    box.querySelector('[data-retry]')?.addEventListener('click', () => uploader.retryFailed());
  });
}

/** Knopf «Aus OneDrive App» zeigen, wenn es den Ordner der OneDrive-App (mit Fotos) gibt. */
function bindCameraRoll(node) {
  const button = root.querySelector('[data-camera-roll]');
  if (!button) return;
  cameraRollInfo(drive)
    .then((roll) => {
      if (!roll || !button.isConnected) return;
      button.hidden = false;
      const label = root.querySelector('[data-gallery-label]');
      if (label) label.textContent = 'Aus Galerie';
    })
    .catch(() => {}); // kein Knopf – Hochladen aus der Galerie geht trotzdem
  button.onclick = () => {
    if (!navigator.onLine) return showToast('Dazu braucht es Internet.');
    openCameraRoll({
      drive,
      dates: node.range,
      names: [...node.media, ...node.hidden].map((m) => m.name),
      onCopy: (sources) => uploader.addCopies(node.id, sources),
    });
  };
}

function pickMedia(node) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*';
  input.hidden = true;
  document.body.appendChild(input);
  input.onchange = () => {
    const all = [...input.files];
    input.remove();
    const files = all.filter((f) => f.size > 0 && (isMediaName(f.name) || /^(image|video)\//.test(f.type)));
    if (files.length < all.length) showToast(`${all.length - files.length} Datei(en) übersprungen – nur Fotos und Videos (Dokumente unten bei «Dokumente»).`);
    if (!files.length) return;
    if (!navigator.onLine) return showToast('Zum Hochladen braucht es Internet.');
    uploader.add(node.id, files);
  };
  input.click();
}

function detailsSection(node) {
  const d = node.details;
  const editLink = `<a class="btn outline small" href="#/bearbeiten/${encodeURIComponent(node.id)}">${icon('edit', 18)} ${hasDetails(d) ? 'Bearbeiten' : 'Details hinzufügen'}</a>`;
  const info = `${node.range ? esc(rangeText(node.range, node.running)) : ''}${node.running ? ' <span class="tag">laufend</span>' : ''}`;
  if (!hasDetails(d)) return `<div class="info row between"><span>${info}</span>${editLink}</div>`;
  const rows = [];
  if (d.place?.value) rows.push(['Ort', esc(d.place.value)]);
  if (d.people?.value?.length) rows.push(['Begleitung', esc(d.people.value.join(', '))]);
  if (d.rating?.value) rows.push(['Bewertung', `<span class="stars">${stars(d.rating.value)}</span>`]);
  return `<div class="section"><div class="sectionhead"><h2>Details</h2>${editLink}</div>
    <div class="panel">
      ${info ? `<div class="muted">${info}</div>` : ''}
      ${rows.length ? `<dl class="rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
      ${d.notes?.value ? `<div class="notes">${esc(d.notes.value)}</div>` : ''}
    </div></div>`;
}

function docsSection(node) {
  const up = state.docUpload?.folderId === node.id ? state.docUpload : null;
  return `<div class="section"><div class="sectionhead"><h2>Dokumente${node.docs.length ? ` <span class="muted">(${node.docs.length})</span>` : ''}</h2>
      <button class="btn outline small" data-add-doc ${up ? 'disabled' : ''}>${icon('add', 18)} Dokument</button></div>
    ${up ? `<div class="status">Lade hoch: ${esc(up.name)} (${up.done + 1} von ${up.total})</div>` : ''}
    ${node.docs.length
      ? `<div class="doclist">${node.docs.map((d, i) => `<button class="docrow" data-doc="${i}">${icon(isImageName(d.name) ? 'photo' : 'download', 20)}<span>${esc(d.name)}</span><span class="muted">${size(d.size)}</span></button>`).join('')}</div>`
      : '<p class="muted small">Noch keine Dokumente.</p>'}
  </div>`;
}

function size(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function bindDocs(node) {
  root.querySelector('[data-add-doc]')?.addEventListener('click', () => pickDocs(node));
  const viewable = node.docs.filter((d) => isImageName(d.name) || /\.pdf$/i.test(d.name));
  root.querySelectorAll('[data-doc]').forEach((b) => {
    b.onclick = async () => {
      const doc = node.docs[Number(b.dataset.doc)];
      // Bilder und PDF: Vorschau im Betrachter (mit Herunterladen); alles andere direkt herunterladen
      if (viewable.includes(doc)) {
        return openViewer({
          photos: viewable.map((d) => ({ id: d.id, fileName: d.name, oneDriveItemId: d.id })),
          start: viewable.indexOf(doc),
          drive,
          thumbs,
        });
      }
      try {
        const url = await drive.downloadUrl(doc.id);
        if (url) location.href = url;
        else showToast('Datei auf OneDrive nicht gefunden.');
      } catch (e) {
        showToast(e.message);
      }
    };
  });
}

function pickDocs(node) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  document.body.appendChild(input);
  input.onchange = async () => {
    const files = [...input.files].filter((f) => f.size > 0);
    input.remove();
    if (!files.length) return;
    if (!navigator.onLine) return showToast('Zum Hochladen braucht es Internet.');
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      state.docUpload = { folderId: node.id, done: i, total: files.length, name: files[i].name };
      render();
      try {
        await drive.upload({ folderId: node.id, name: `Dokumente/${cleanFileName(files[i].name)}` }, files[i]);
        ok++;
      } catch (e) {
        console.error(e);
        showToast(`«${files[i].name}» nicht hochgeladen: ${e.message || e}`);
      }
    }
    state.docUpload = null;
    if (ok) showToast(ok === 1 ? '1 Dokument hochgeladen' : `${ok} Dokumente hochgeladen`);
    await rescan();
  };
  input.click();
}

/** Nur leere Ordner (keine Fotos, Dokumente, Unterordner) dürfen gelöscht werden – nie der Ablageordner. */
function isEmptyFolder(node) {
  return node.depth > 0 && !node.media.length && !node.hidden.length && !node.children.length && !node.docs.length && !node.docsFolderId &&
    !uploader.isRunning();
}

async function deleteFolder(node) {
  if (!navigator.onLine) return showToast('Zum Löschen braucht es Internet.');
  const yes = await askConfirm(`Ordner «${pretty(node.name)}» löschen?\n\nEr ist leer. Er kommt in den OneDrive-Papierkorb.`, { ok: 'Löschen', danger: true });
  if (!yes) return;
  try {
    // OneDrive prüft selbst nochmals, ob wirklich nichts drin ist (auch Dateien, die die App nicht zeigt)
    await drive.deleteEmptyFolder(node.id);
  } catch (e) {
    console.error(e);
    if (e instanceof NotEmptyError) return showToast('Nicht gelöscht: Im Ordner liegt auf OneDrive noch etwas.');
    if (e instanceof ConflictError) return showToast('Nicht gelöscht: Der Ordner wurde inzwischen geändert. Bitte nochmals.');
    return showToast(`Nicht gelöscht: ${e.message || e}`);
  }
  applyDelta(state.items, [{ id: node.id, deleted: {} }]);
  rebuild();
  showToast('Ordner gelöscht');
  const parent = state.lib?.byId.get(node.parentId);
  location.replace(parent && parent.depth > 0 ? `#/f/${encodeURIComponent(parent.id)}` : '#/ordner');
  rescan();
}

function ancestors(node) {
  const list = [];
  let n = state.lib.byId.get(node.parentId);
  while (n && n.depth > 0) {
    list.unshift(n);
    n = state.lib.byId.get(n.parentId);
  }
  return list;
}

// --- Neues Event / Details bearbeiten ---

function renderNew(parentId) {
  if (!state.lib && !state.rootMissing) {
    root.innerHTML = `${topbar('Neues Event', { back: true })}<div class="empty">Ordner werden noch eingelesen …</div>`;
    formOpenFor = null;
    return bindActions();
  }
  renderCreate(root, {
    book,
    drive,
    lib: state.lib,
    parentId,
    ensureRoot,
    onCreated: applyLocal,
    done: (id) => {
      formOpenFor = null;
      state.justCreated = id;
      location.replace(`#/f/${encodeURIComponent(id)}`);
      rescan();
    },
    cancel: goBack,
  });
}

function renderEditScreen(id) {
  const node = state.lib?.byId.get(id);
  if (!node || node.depth === 0) {
    root.innerHTML = `${topbar('Details', { back: true })}<div class="empty">${state.scanning ? 'Wird geladen …' : 'Diesen Ordner gibt es nicht mehr.'}</div>`;
    formOpenFor = null;
    return bindActions();
  }
  renderEdit(root, {
    book,
    drive,
    lib: state.lib,
    node,
    onRenamed: applyLocal,
    done: () => {
      formOpenFor = null;
      showToast('Gespeichert');
      goBack();
      syncNow();
    },
    cancel: goBack,
  });
}

function goBack() {
  formOpenFor = null;
  if (history.length > 1) history.back();
  else location.hash = '#/';
}

// --- Einstellungen ---

function renderSettings() {
  const theme = localStorage.getItem('lifephotobook-theme') || 'system';
  const doc = book.current();
  const favs = favorites(doc);
  const people = allPeople(doc);
  root.innerHTML = `
    ${topbar('Einstellungen', { back: true })}
    <div class="section"><h2>Konto</h2>
      <div class="panel">Angemeldet als <b>${esc(state.user.name)}</b><br><span class="muted">${esc(state.user.username)}</span>
        <div class="row"><button class="btn outline" data-action="signout">Abmelden</button></div></div></div>
    <div class="section"><h2>OneDrive</h2>
      <div class="panel">Ablageordner: <b>${esc(state.rootPath ?? '–')}</b><br>
        <span class="muted">Zuletzt abgeglichen: ${state.lastScan ? esc(dateTime(state.lastScan)) : 'noch nie'}</span>
        <p class="muted">Neue Ordner und Fotos (z. B. vom Fotosortierer) findet die App beim Öffnen selbst.
          Falls einmal etwas nicht stimmt:</p>
        <div class="row"><button class="btn outline" data-action="fullscan" ${state.scanning ? 'disabled' : ''}>${icon('sync', 18)} Alles neu mit OneDrive abgleichen</button></div></div></div>
    <div class="section"><h2>Begleitung – Favoriten</h2>
      <p class="muted small">Favoriten erscheinen beim Bearbeiten als Knopf zum schnellen Hinzufügen (höchstens 8).</p>
      ${people.length
        ? `<div class="partnergrid">${people.map((p) => {
            const on = favs.some((f) => f.toLowerCase() === p.toLowerCase());
            return `<button class="chip${on ? ' on' : ''}" data-person="${esc(p)}" aria-pressed="${on}">${on ? '★' : '☆'} ${esc(p)}</button>`;
          }).join('')}</div>`
        : '<p class="muted">Noch keine Personen eingetragen.</p>'}</div>
    <div class="section"><h2>Darstellung</h2>
      <div class="chips nopad">${[['system', 'Wie Gerät'], ['light', 'Hell'], ['dark', 'Dunkel']]
        .map(([v, l]) => `<button class="chip${theme === v ? ' on' : ''}" data-theme="${v}">${l}</button>`)
        .join('')}</div></div>
    <p class="hint">${esc(APP_NAME)} · ${esc(APP_VERSION)}</p>`;
  root.querySelectorAll('[data-theme]').forEach((b) => {
    b.onclick = () => {
      localStorage.setItem('lifephotobook-theme', b.dataset.theme);
      applyTheme(b.dataset.theme);
      renderSettings();
      bindActions();
    };
  });
  root.querySelectorAll('[data-person]').forEach((b) => {
    b.onclick = async () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      await book.update((d) => setFavorite(d, b.dataset.person, on, Date.now()));
      syncNow();
    };
  });
}

function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function bindActions() {
  root.querySelectorAll('[data-action]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.action;
      if (a === 'back') goBack();
      else if (a === 'rescan') {
        rescan();
        syncNow();
      } else if (a === 'fullscan') rescan(true);
      else if (a === 'relogin') auth.signInAgain();
      else if (a === 'signout') {
        if (!(await askConfirm('Abmelden? Die Fotos bleiben auf OneDrive, auf diesem Gerät wird nur der eingelesene Stand gelöscht.', { ok: 'Abmelden' }))) return;
        await store.clearAll();
        auth.signOut();
      }
    };
  });
}

function renderWelcome() {
  root.innerHTML = `
    <div class="welcome">
      <img src="icons/icon.svg" width="72" height="72" alt="">
      <h1>${APP_NAME}</h1>
      <p>Deine Fotos aus dem Leben – Ferien, Familie, Feste – geordnet in deinem eigenen OneDrive.
         Melde dich mit deinem Microsoft-Konto an.</p>
      ${state.startError ? `<div class="status error">${esc(state.startError)}</div>` : ''}
      <button class="btn" id="signin" ${CLIENT_ID ? '' : 'disabled'}>Mit Microsoft anmelden</button>
    </div>`;
  root.querySelector('#signin').onclick = () => auth.signIn().catch((e) => showToast('Anmeldung fehlgeschlagen: ' + (e.message || e)));
}

// Offline-Speicher (sw.js): neue Versionen kommen so zuverlässig an. Bei jeder Änderung CACHE in sw.js erhöhen.
if ('serviceWorker' in navigator && window.self === window.top) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline-Speicher nicht verfügbar', e));
}

start();
