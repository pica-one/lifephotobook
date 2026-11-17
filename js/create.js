// Bildschirm "Neues Event": Thema wählen (oder neu), dann Unterordner wählen oder neu anlegen – beliebig tief.
// Der neue Ordner wird sofort auf OneDrive erstellt. Details, Fotos und Dokumente kommen danach (oder nie).

import { setFolderDetails } from './book.js';
import { icon } from './icons.js';
import { FORMAT_LABELS, folderName, nameTaken, needsDate, needsName, suggestFormat } from './naming.js';
import { ConflictError } from './onedrive.js';
import { esc, showToast, todayIso, topbar } from './ui.js';

/**
 * ctx: { book, drive, lib (oder null, wenn es den Ablageordner noch nicht gibt), parentId,
 *        ensureRoot() → rootId, onCreated(rawItem), done(newFolderId), cancel() }
 */
export function renderCreate(root, ctx) {
  const { lib } = ctx;
  const parent = (ctx.parentId && lib?.byId.get(ctx.parentId)) || lib?.root || null;
  const atRoot = !parent || parent.depth === 0;
  const childNames = parent?.children.map((c) => c.name) ?? [];
  const saved = parent?.details?.nameFormat?.value ?? null;
  const guess = suggestFormat(null, childNames);
  const f = { format: atRoot ? 'NAME' : suggestFormat(saved, childNames), name: '', date: todayIso() };

  const crumbs = [];
  for (let n = parent; n && n.depth > 0; n = lib.byId.get(n.parentId)) crumbs.unshift(n);

  root.innerHTML = `
    ${topbar('Neues Event', { back: true })}
    <nav class="crumbs"><a href="#/neu">Themen</a>${crumbs.map((c) => ` › <a href="#/neu/${encodeURIComponent(c.id)}">${esc(c.name.replace(/_/g, ' '))}</a>`).join('')}</nav>

    ${parent?.children.length ? `<div class="section"><h2>${atRoot ? '1. Thema wählen' : 'In einen Unterordner?'}</h2>
      <div class="pick">${parent.children.map((c) => `<a class="pickrow" href="#/neu/${encodeURIComponent(c.id)}">${icon('folder', 20)}<span>${esc(c.name.replace(/_/g, ' '))}</span>
        <span class="muted">${c.children.length ? `${c.children.length} Ordner` : ''}</span><span class="chev">›</span></a>`).join('')}</div></div>` : ''}

    <div class="section"><h2>${atRoot ? (parent?.children.length ? '… oder neues Thema' : 'Neues Thema') : `Neuer Ordner in «${esc(parent.name.replace(/_/g, ' '))}»`}</h2>
      <div class="panel">
        ${atRoot ? '' : `<div class="chips nopad" id="formats">${Object.entries(FORMAT_LABELS)
          .map(([k, l]) => `<button type="button" class="chip${f.format === k ? ' on' : ''}" data-format="${k}">${esc(l)}</button>`)
          .join('')}</div>`}
        <label class="field" id="nameField"><span>Name</span><input id="name" placeholder="${atRoot ? 'z. B. Ferien, Gottekinder' : 'z. B. Sardinien'}" autocomplete="off"></label>
        <label class="field" id="dateField"><span>Datum</span><input type="date" id="date" value="${f.date}"></label>
        <p class="preview" id="preview"></p>
        <p class="formerror" id="error" hidden></p>
        <button class="btn wide" id="create">${icon('add', 20)} Ordner anlegen</button>
      </div></div>

    ${!atRoot ? `<div class="section"><p class="muted small">Oder die Fotos direkt in «${esc(parent.name.replace(/_/g, ' '))}» ablegen:</p>
      <a class="btn outline wide" href="#/f/${encodeURIComponent(parent.id)}">Diesen Ordner öffnen</a></div>` : ''}`;

  const $ = (sel) => root.querySelector(sel);
  $('[data-action="back"]').onclick = ctx.cancel;

  const draw = () => {
    $('#nameField').hidden = !needsName(f.format);
    $('#dateField').hidden = !needsDate(f.format);
    const n = folderName(f.format, $('#name').value, $('#date').value);
    const where = [...crumbs.map((c) => c.name), n || '…'].join(' / ');
    $('#preview').innerHTML = `Neuer Ordner: <b>${esc(where)}</b>`;
  };
  root.querySelectorAll('[data-format]').forEach((b) => {
    b.onclick = () => {
      f.format = b.dataset.format;
      root.querySelectorAll('[data-format]').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
  });
  $('#name').oninput = draw;
  $('#date').oninput = draw;
  draw();
  setTimeout(() => $('#name').focus(), 50);

  const showError = (t) => {
    $('#error').textContent = t;
    $('#error').hidden = !t;
  };

  $('#create').onclick = async () => {
    const name = folderName(f.format, $('#name').value, $('#date').value);
    if (!name) return showError(needsName(f.format) && !$('#name').value.trim() ? 'Bitte einen Namen eingeben.' : 'Bitte ein Datum wählen.');
    if (nameTaken(name, childNames)) return showError(`Den Ordner «${name}» gibt es hier schon – oben antippen, um ihn zu öffnen.`);
    if (!navigator.onLine) return showError('Zum Anlegen braucht es Internet.');
    showError('');
    $('#create').disabled = true;
    try {
      const parentId = parent?.id ?? (await ctx.ensureRoot());
      const raw = await ctx.drive.createFolder(parentId, name);
      ctx.onCreated(raw);
      // Gewähltes Format merken, wenn es nicht dem automatischen Vorschlag entspricht (wie im Fotosortierer)
      if (!atRoot && parent && (saved || f.format !== guess)) {
        await ctx.book.update((d) => setFolderDetails(d, parent.id, { nameFormat: f.format }, Date.now()));
      }
      ctx.done(raw.id);
    } catch (e) {
      console.error(e);
      $('#create').disabled = false;
      showError(e instanceof ConflictError ? `Den Ordner «${name}» gibt es auf OneDrive schon.` : 'Anlegen fehlgeschlagen: ' + (e.message || e));
      showToast('Ordner nicht angelegt.');
    }
  };
}
