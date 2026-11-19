// Auswahl-Modus (Anforderungen Kap. 8): Fotos antippen → Häkchen; unten eine Leiste mit
// «ZIP herunterladen», «Teilen» (Handy), «Herz» und «Ausblenden» für alle ausgewählten.
// Die Auswahl gilt für einen Bildschirm ("scope", z. B. ein Ordner oder die Suche).

import { icon } from './icons.js';
import { isLiked, isVideoName } from './media.js';
import { askConfirm, showToast } from './ui.js';
import { buildZip, splitParts, uniqueNames } from './zip.js';

/** Höchstens so gross wird eine ZIP-Datei (Handy weniger, sonst geht dem Browser der Speicher aus). */
const ZIP_MAX_PC = 1500 * 1024 * 1024;
const ZIP_MAX_PHONE = 500 * 1024 * 1024;
/** Teilen: mehr nehmen WhatsApp & Co. kaum an. */
const SHARE_MAX_FILES = 30;
const SHARE_MAX_BYTES = 200 * 1024 * 1024;
const PARALLEL = 3;

const isPhone = () => matchMedia('(pointer: coarse)').matches;

/**
 * drive: OneDrive-Zugriff; flag(ids, field, value): Herz/Ausblenden speichern; onChange(): Bildschirm neu zeichnen.
 */
export function createSelection({ drive, flag, onChange }) {
  let scope = null;
  const ids = new Set();
  let pool = []; // [{ m: Foto, folder: Ordnername }] – was auf dem Bildschirm auswählbar ist
  let zipName = 'Fotos';
  let job = null; // { kind: 'zip'|'share', done, total, part, parts, cancelled, files? }
  let bar = null;

  const api = {
    active: (s) => scope === s,
    busy: () => !!job && !job.ready,
    start(s) {
      scope = s;
      ids.clear();
      onChange();
    },
    /** Auswahl beenden. silent: nicht neu zeichnen (z. B. weil ohnehin ein anderer Bildschirm kommt). */
    stop(silent = false) {
      if (!scope) return;
      if (job && !job.ready) job.cancelled = true;
      scope = null;
      ids.clear();
      job = null;
      bar?.remove();
      bar = null;
      document.body.classList.remove('selecting');
      if (!silent) onChange();
    },
    /** Alle Fotos einer Liste gleich als ZIP herunterladen (z. B. die Fotos eines Fotobuchs). */
    async zipAll(items, folderOf, name) {
      if (job && !job.ready) return;
      scope = 'zip';
      pool = items.map((m) => ({ m, folder: folderOf(m) }));
      zipName = name;
      ids.clear();
      items.forEach((m) => ids.add(m.id));
      bar?.remove();
      bar = document.createElement('div');
      bar.className = 'selbar';
      document.body.appendChild(bar);
      await makeZip(chosen());
      api.stop(true);
    },
    has: (id) => ids.has(id),
    count: () => ids.size,
    /** Alle (on=true) oder keine auswählen. */
    setAll(list, on) {
      for (const m of list) on ? ids.add(m.id) : ids.delete(m.id);
      refreshCells();
      drawBar();
    },
    /**
     * Nach jedem Neuzeichnen: Häkchen in den Zellen setzen, Antippen = auswählen, Leiste zeigen.
     * cells: Selektor der Zellen; items: Fotos in der Reihenfolge der Zellen-Nummern; folderOf(m): Ordnername fürs ZIP.
     */
    mount(rootEl, s, { cells, attr, items, folderOf, name }) {
      if (scope !== s) return false;
      document.body.classList.add('selecting');
      pool = items.map((m) => ({ m, folder: folderOf(m) }));
      zipName = name;
      // Ausgewählte, die es nicht mehr gibt (z. B. ausgeblendet), weglassen
      const exist = new Set(items.map((m) => m.id));
      for (const id of [...ids]) if (!exist.has(id)) ids.delete(id);
      rootEl.querySelectorAll(cells).forEach((b) => {
        const m = items[Number(b.getAttribute(attr))];
        if (!m) return;
        b.classList.add('selectable');
        b.classList.toggle('picked', ids.has(m.id));
        b.setAttribute('aria-pressed', ids.has(m.id));
        b.onclick = () => {
          if (job && !job.ready) return;
          ids.has(m.id) ? ids.delete(m.id) : ids.add(m.id);
          if (job?.ready) job = null; // Auswahl geändert: «Jetzt teilen» gilt nicht mehr
          b.classList.toggle('picked', ids.has(m.id));
          b.setAttribute('aria-pressed', ids.has(m.id));
          drawBar();
        };
      });
      if (!bar || !bar.isConnected) {
        bar = document.createElement('div');
        bar.className = 'selbar';
        document.body.appendChild(bar);
      }
      drawBar();
      return true;
    },
  };

  function refreshCells() {
    document.querySelectorAll('.cell.selectable').forEach((b) => {
      const img = b.querySelector('img[data-item]');
      const on = img && ids.has(img.dataset.item);
      b.classList.toggle('picked', !!on);
      b.setAttribute('aria-pressed', !!on);
    });
  }

  function chosen() {
    return pool.filter((p) => ids.has(p.m.id));
  }

  function drawBar() {
    if (!bar) return;
    const list = chosen();
    const n = list.length;
    const bytes = list.reduce((s, p) => s + (p.m.size ?? 0), 0);
    let html;
    if (job && !job.ready) {
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      const what = job.kind === 'zip'
        ? `ZIP wird erstellt${job.parts > 1 ? ` (Teil ${job.part} von ${job.parts})` : ''}: ${job.done} von ${job.total}`
        : `Wird geladen: ${job.done} von ${job.total}`;
      html = `<div class="selinfo">${what}<div class="bar"><span style="width:${pct}%"></span></div></div>
        <button class="btn outline small" data-sel="cancel">Abbrechen</button>`;
    } else if (job?.ready) {
      html = `<div class="selinfo">${job.files.length === 1 ? '1 Datei' : `${job.files.length} Dateien`} bereit</div>
        <button class="btn small" data-sel="sharenow">${icon('share', 18)} Jetzt teilen</button>
        <button class="iconbtn" data-sel="close" aria-label="Auswahl beenden">${icon('close')}</button>`;
    } else {
      const allLiked = n > 0 && list.every((p) => isVideoName(p.m.name) || isLiked(p.m));
      const canShare = !!navigator.canShare && typeof File !== 'undefined';
      html = `<div class="selinfo"><b>${n}</b> ausgewählt
          <div class="sellinks">${n ? `<span class="muted">${size(bytes)}</span> · ` : ''}<button class="linkbtn" data-sel="all">Alle</button>${n ? ' · <button class="linkbtn" data-sel="none">Keine</button>' : ''}</div></div>
        <div class="selbtns">
          <button class="iconbtn" data-sel="zip" aria-label="Als ZIP herunterladen" title="Als ZIP herunterladen" ${n ? '' : 'disabled'}>${icon('download')}</button>
          ${canShare ? `<button class="iconbtn" data-sel="share" aria-label="Teilen" title="Teilen" ${n ? '' : 'disabled'}>${icon('share')}</button>` : ''}
          <button class="iconbtn${allLiked ? ' on' : ''}" data-sel="like" aria-label="${allLiked ? 'Herz entfernen' : 'Herz geben'}" title="${allLiked ? 'Herz entfernen' : 'Herz geben'}" ${n ? '' : 'disabled'}>${icon('heart')}</button>
          <button class="iconbtn" data-sel="hide" aria-label="Ausblenden" title="Ausblenden" ${n ? '' : 'disabled'}>${icon('hide')}</button>
          <button class="iconbtn" data-sel="close" aria-label="Auswahl beenden" title="Auswahl beenden">${icon('close')}</button>
        </div>`;
    }
    bar.innerHTML = html;
    bar.querySelectorAll('[data-sel]').forEach((b) => (b.onclick = () => act(b.dataset.sel)));
  }

  async function act(a) {
    const list = chosen();
    if (a === 'close') return api.stop();
    if (a === 'all') return api.setAll(pool.map((p) => p.m), true);
    if (a === 'none') return api.setAll(pool.map((p) => p.m), false);
    if (a === 'cancel') {
      if (job) job.cancelled = true;
      return;
    }
    if (a === 'like') {
      const stills = list.filter((p) => !isVideoName(p.m.name));
      if (!stills.length) return showToast('Videos bekommen kein Herz.');
      const on = !stills.every((p) => isLiked(p.m));
      await flag(stills.map((p) => p.m.id), 'liked', on);
      return showToast(on ? `${stills.length} Foto(s) mit Herz` : `Herz bei ${stills.length} Foto(s) entfernt`);
    }
    if (a === 'hide') {
      const ok = await askConfirm(`${list.length === 1 ? '1 Foto' : `${list.length} Fotos`} ausblenden?\n\nSie verschwinden nur in der App. Auf OneDrive bleiben sie, und du kannst sie wieder einblenden.`, { ok: 'Ausblenden' });
      if (!ok) return;
      const n = list.length;
      ids.clear();
      await flag(list.map((p) => p.m.id), 'hidden', true);
      return showToast(`${n} ausgeblendet`);
    }
    if (a === 'zip') return makeZip(list);
    if (a === 'share') return prepareShare(list);
    if (a === 'sharenow') return shareNow();
  }

  /** Originale holen (3 gleichzeitig). Gibt [{ p, blob }] zurück; fehlende werden gezählt. */
  async function fetchAll(list, onOne) {
    const out = new Array(list.length);
    let next = 0;
    let missing = 0;
    async function worker() {
      while (next < list.length && !job?.cancelled) {
        const i = next++;
        try {
          const url = await drive.downloadUrl(list[i].m.id);
          const res = url ? await fetch(url) : null;
          if (!res?.ok) throw new Error('nicht gefunden');
          out[i] = { p: list[i], blob: await res.blob() };
        } catch (e) {
          console.warn('Original', list[i].m.name, e);
          missing++;
        }
        onOne();
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return { files: out.filter(Boolean), missing };
  }

  async function makeZip(list) {
    if (!navigator.onLine) return showToast('Zum Herunterladen braucht es Internet.');
    const parts = splitParts(list.map((p) => ({ ...p, size: p.m.size ?? 0 })), isPhone() ? ZIP_MAX_PHONE : ZIP_MAX_PC);
    job = { kind: 'zip', done: 0, total: list.length, part: 1, parts: parts.length, cancelled: false };
    drawBar();
    const oneFolder = new Set(list.map((p) => p.folder)).size <= 1;
    let missing = 0;
    try {
      for (let i = 0; i < parts.length && !job.cancelled; i++) {
        job.part = i + 1;
        drawBar();
        const r = await fetchAll(parts[i], () => {
          job.done++;
          drawBar();
        });
        missing += r.missing;
        if (job.cancelled) break;
        const names = uniqueNames(r.files.map(({ p }) => (oneFolder ? p.m.name : `${p.folder}/${p.m.name}`)));
        const blob = await buildZip(r.files.map(({ p, blob }, k) => ({ name: names[k], data: blob, date: p.m.date ?? null })));
        save(blob, parts.length > 1 ? `${zipName} (${i + 1} von ${parts.length}).zip` : `${zipName}.zip`);
      }
      if (job.cancelled) showToast('Abgebrochen');
      else showToast(`${parts.length > 1 ? `${parts.length} ZIP-Dateien` : 'ZIP-Datei'} heruntergeladen${missing ? ` · ${missing} Datei(en) fehlten` : ''}`);
    } catch (e) {
      console.error(e);
      showToast(`ZIP nicht erstellt: ${e.message || e}`);
    } finally {
      job = null;
      drawBar();
    }
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  /** Teilen in zwei Schritten: erst laden, dann «Jetzt teilen» (der Browser erlaubt Teilen nur direkt nach Antippen). */
  async function prepareShare(list) {
    if (!navigator.onLine) return showToast('Zum Teilen braucht es Internet.');
    const bytes = list.reduce((s, p) => s + (p.m.size ?? 0), 0);
    if (list.length > SHARE_MAX_FILES || bytes > SHARE_MAX_BYTES) {
      return showToast(`Zum Teilen höchstens ${SHARE_MAX_FILES} Dateien und ${size(SHARE_MAX_BYTES)} – mehr lieber als ZIP herunterladen.`);
    }
    job = { kind: 'share', done: 0, total: list.length, cancelled: false };
    drawBar();
    const r = await fetchAll(list, () => {
      job.done++;
      drawBar();
    });
    if (job.cancelled) {
      job = null;
      drawBar();
      return showToast('Abgebrochen');
    }
    const files = r.files.map(({ p, blob }) => new File([blob], p.m.name, { type: blob.type && blob.type !== 'application/octet-stream' ? blob.type : guessType(p.m.name) }));
    if (!files.length || !navigator.canShare({ files })) {
      job = null;
      drawBar();
      return showToast(files.length ? 'Dieser Browser kann diese Dateien nicht teilen. Als ZIP herunterladen?' : 'Dateien konnten nicht geladen werden.');
    }
    if (r.missing) showToast(`${r.missing} Datei(en) konnten nicht geladen werden.`);
    job = { kind: 'share', ready: true, files };
    drawBar();
  }

  async function shareNow() {
    const files = job?.files ?? [];
    try {
      await navigator.share({ files });
      job = null;
      drawBar();
    } catch (e) {
      if (e?.name !== 'AbortError') showToast(`Teilen ging nicht: ${e.message || e}`);
    }
  }

  return api;
}

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', '3gp': 'video/3gpp' }[ext] ?? 'application/octet-stream';
}

function size(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

