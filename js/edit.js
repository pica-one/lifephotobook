// Bildschirm "Details bearbeiten" eines Ordners/Events (alles freiwillig).
// Name ändern benennt den Ordner auf OneDrive um (Fotos darin bleiben, wie sie sind).

import { allPeople, favorites, setFolderDetails } from './book.js';
import { icon } from './icons.js';
import { FORMAT_LABELS, cleanFileName, nameTaken } from './naming.js';
import { ConflictError } from './onedrive.js';
import { esc, fmtDate, normalizeText, rankByUse, sameText, showToast, topbar } from './ui.js';

/**
 * ctx: { book, drive, lib, node, onRenamed(rawItem), done(), cancel() }
 */
export function renderEdit(root, ctx) {
  const { book, drive, node } = ctx;
  const doc = book.current();
  const d = node.details ?? {};
  const isTheme = node.depth === 1;
  const own = ownRange(node);
  const f = {
    name: node.name,
    start: d.dates?.value?.start ?? '',
    end: d.dates?.value?.end ?? '',
    place: d.place?.value ?? '',
    people: [...(d.people?.value ?? [])],
    rating: d.rating?.value ?? 0,
    notes: d.notes?.value ?? '',
    status: d.status?.value ?? null,
    nameFormat: d.nameFormat?.value ?? null,
  };
  const places = rankByUse(doc.folders.map((x) => x.place?.value ?? ''));
  const known = allPeople(doc);
  const favs = favorites(doc);
  const siblings = (ctx.lib.byId.get(node.parentId)?.children ?? []).filter((c) => c.id !== node.id).map((c) => c.name);

  root.innerHTML = `
    ${topbar(isTheme ? 'Thema bearbeiten' : 'Details bearbeiten', { back: true })}
    <form id="form" class="form" novalidate>
      <div class="section"><h2>Ordner</h2>
        <label class="field"><span>Name auf OneDrive</span><input id="name" value="${esc(f.name)}" autocomplete="off"></label>
        <p class="muted small">Ändern benennt den Ordner auf OneDrive um. Die Fotos darin bleiben unverändert.</p>
      </div>

      <div class="section"><h2>Datum</h2>
        <div class="dates">
          <label class="field"><span>Von</span><input type="date" id="start" value="${f.start}"></label>
          <label class="field"><span>Bis</span><input type="date" id="end" value="${f.end}"></label>
        </div>
        <p class="muted small">${own ? `Leer lassen = automatisch aus den Fotos (${esc(fmtDate(own.start))}${own.end !== own.start ? ` – ${esc(fmtDate(own.end))}` : ''}).` : 'Leer lassen = automatisch aus den Fotos.'}
          <button type="button" class="linkbtn" id="clearDates">Datum leeren</button></p>
      </div>

      <div class="section"><h2>Ort</h2>
        <label class="field"><input id="place" list="places" value="${esc(f.place)}" placeholder="z. B. Cala Gonone, Sardinien" autocomplete="off" aria-label="Ort"></label>
      </div>

      <div class="section"><h2>Begleitung</h2>
        <div class="partnerchips" id="peopleChips"></div>
        <div class="favs" id="favs"></div>
        <div class="addpartner">
          <input id="personInput" list="peopleList" placeholder="Name eingeben" autocomplete="off" aria-label="Person hinzufügen">
          <button type="button" class="btn outline" id="addPerson" aria-label="Hinzufügen">${icon('add', 20)}</button>
        </div>
      </div>

      <div class="section"><h2>Bewertung</h2>
        <div class="rating" id="rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} Sterne">☆</button>`).join('')}</div>
      </div>

      <div class="section"><h2>Notizen</h2>
        <label class="field"><textarea id="notes" rows="6" placeholder="z. B. mit wem, welches Hotel, was war besonders …" aria-label="Notizen">${esc(f.notes)}</textarea></label>
      </div>

      <div class="section"><h2>Status</h2>
        <div class="chips nopad" id="status">
          ${[[null, 'Automatisch'], ['LAUFEND', 'Laufend'], ['ABGESCHLOSSEN', 'Abgeschlossen']]
            .map(([v, l]) => `<button type="button" class="chip${f.status === v ? ' on' : ''}" data-status="${v ?? ''}">${l}</button>`)
            .join('')}
        </div>
        <p class="muted small">Laufend = wächst immer weiter (z. B. Gottekinder). Steht in der Zeitleiste beim neusten Foto.</p>
      </div>

      <div class="section"><h2>Neue Unterordner</h2>
        <label class="field"><span>Namensformat</span>
          <select id="nameFormat">
            <option value="">Automatisch (wie die bestehenden)</option>
            ${Object.entries(FORMAT_LABELS).map(([k, l]) => `<option value="${k}" ${f.nameFormat === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select></label>
      </div>

      <div class="section"><p class="formerror" id="error" hidden></p>
        <button type="submit" class="btn wide" id="save">Speichern</button></div>
    </form>
    <datalist id="places">${places.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <datalist id="peopleList">${known.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>`;

  const $ = (sel) => root.querySelector(sel);
  $('[data-action="back"]').onclick = ctx.cancel;
  root.querySelectorAll('[data-action="rescan"]').forEach((b) => (b.hidden = true));

  $('#start').onchange = () => {
    if ($('#start').value && (!$('#end').value || $('#end').value < $('#start').value)) $('#end').value = $('#start').value;
  };
  $('#clearDates').onclick = () => {
    $('#start').value = '';
    $('#end').value = '';
  };

  // Bewertung: gleicher Stern nochmals = keine Bewertung
  const drawRating = () =>
    root.querySelectorAll('[data-star]').forEach((b) => {
      const on = Number(b.dataset.star) <= f.rating;
      b.textContent = on ? '★' : '☆';
      b.classList.toggle('on', on);
    });
  root.querySelectorAll('[data-star]').forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.star);
      f.rating = f.rating === n ? 0 : n;
      drawRating();
    };
  });
  drawRating();

  root.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = () => {
      f.status = b.dataset.status || null;
      root.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });

  // Begleitung
  const drawPeople = () => {
    $('#peopleChips').innerHTML = f.people.length
      ? f.people.map((p, i) => `<span class="pchip">${esc(p)}<button type="button" data-remove="${i}" aria-label="${esc(p)} entfernen">${icon('close', 16)}</button></span>`).join('')
      : '<span class="muted">Noch niemand</span>';
    const open = favs.filter((n) => !f.people.some((p) => sameText(p, n)));
    $('#favs').innerHTML = open.map((n) => `<button type="button" class="chip" data-fav="${esc(n)}">+ ${esc(n)}</button>`).join('');
    root.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = () => {
      f.people.splice(Number(b.dataset.remove), 1);
      drawPeople();
    }));
    root.querySelectorAll('[data-fav]').forEach((b) => (b.onclick = () => addPerson(b.dataset.fav)));
  };
  const addPerson = (name) => {
    const n = normalizeText(name);
    if (!n) return;
    const k = known.find((x) => sameText(x, n)) ?? n; // Schreibweise einer bekannten Person übernehmen
    if (!f.people.some((p) => sameText(p, k))) f.people.push(k);
    drawPeople();
  };
  $('#addPerson').onclick = () => {
    addPerson($('#personInput').value);
    $('#personInput').value = '';
    $('#personInput').focus();
  };
  $('#personInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#addPerson').click();
    }
  });
  drawPeople();

  const showError = (text) => {
    $('#error').textContent = text;
    $('#error').hidden = !text;
  };

  // Speichern
  $('#form').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#personInput').value.trim()) addPerson($('#personInput').value);
    const start = $('#start').value;
    const end = $('#end').value || start;
    if (!start && $('#end').value) return showError('Bitte auch das Startdatum wählen (oder beide leer lassen).');
    if (start && end < start) return showError('Das Enddatum darf nicht vor dem Startdatum liegen.');
    const newName = cleanFileName(normalizeText($('#name').value));
    if (!normalizeText($('#name').value)) return showError('Der Ordner braucht einen Namen.');
    if (newName !== node.name && nameTaken(newName, siblings) && newName.toLowerCase() !== node.name.toLowerCase()) {
      return showError(`Hier gibt es schon einen Ordner «${newName}».`);
    }
    showError('');
    $('#save').disabled = true;
    try {
      let names = node.names;
      if (newName !== node.name) {
        if (!navigator.onLine) throw new Error('Zum Umbenennen braucht es Internet.');
        const raw = await drive.rename(node.id, newName);
        ctx.onRenamed(raw);
        names = [...node.names.slice(0, -1), raw.name];
      }
      const values = {
        path: names.join('/'),
        dates: start ? { start, end } : null,
        place: normalizeText($('#place').value) || null,
        people: f.people,
        rating: f.rating,
        notes: $('#notes').value.trim() ? $('#notes').value.replace(/\s+$/, '') : null,
        status: f.status,
        nameFormat: $('#nameFormat').value || null,
      };
      await book.update((current) => setFolderDetails(current, node.id, values, Date.now()));
      ctx.done();
    } catch (err) {
      console.error(err);
      $('#save').disabled = false;
      showError(err instanceof ConflictError ? `Hier gibt es schon einen Ordner «${newName}».` : 'Speichern fehlgeschlagen: ' + (err.message || err));
      showToast('Nicht gespeichert.');
    }
  };
}

function ownRange(node) {
  const dates = node.media.map((m) => m.date).filter(Boolean);
  return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
}
