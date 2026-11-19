// Fotos und Videos in ein Event (OneDrive-Ordner) hochladen – mit Fortschritt.
// Vorlage: upload.js vom Tourenbuch, vereinfacht: das Ziel ist immer ein bestehender Ordner (Kennung).
// Schneller als im Tourenbuch: bis zu 3 Dateien gleichzeitig.
// Der Dateiname bleibt (Fotos werden nie umbenannt). Liegt im Ordner schon eine Datei mit gleichem Namen
// UND gleicher Grösse, ist es dasselbe Foto → wird übersprungen. Gleicher Name, andere Grösse: OneDrive vergibt
// einen neuen Namen (z. B. "IMG_1234 1.jpg") – es wird nie etwas überschrieben.
// Die Dateien bleiben nur im Speicher: wird die Seite vorher geschlossen, müssen sie neu ausgewählt werden.
// Zusätzlich (wie im Tourenbuch): Fotos, die schon auf OneDrive liegen (aus der OneDrive-App am Handy, Ordner
// "Eigene Aufnahmen"), werden auf OneDrive in den Ordner KOPIERT (addCopies). So bleibt der Aufnahmeort, den
// Android beim Hochladen aus dem Browser entfernt. Das Original bleibt, wo es ist. Gleiche Regeln: gleicher Name +
// gleiche Grösse schon da → übersprungen; gleicher Name, andere Grösse → "Name 1.jpg" (wie OneDrive selbst).

import { cleanFileName } from './naming.js';
import { AuthError, BusyError } from './onedrive.js';

export const PARALLEL_UPLOADS = 3;

/** Schlüssel für "dasselbe Foto": Name (ohne Gross-/Kleinschreibung) + Grösse. */
export function sameFileKey(name, size) {
  return `${cleanFileName(name).toLowerCase()}|${size}`;
}

/**
 * existing(folderId) → [{ name, size }] Dateien, die schon im Ordner liegen (auch ausgeblendete).
 * onFinished(uploaded, skipped) wenn alles fertig ist.
 */
export function createUploader({ drive, existing = () => [], onChange = () => {}, onFinished = () => {}, parallel = PARALLEL_UPLOADS }) {
  const queue = []; // { folderId, file } oder { folderId, file: { name, size }, source } (Kopie auf OneDrive)
  const active = new Map(); // job → { folderId, name, progress }
  const known = new Map(); // folderId → Set(sameFileKey) – schon vorhanden, wartend oder hochgeladen
  let running = false;
  let uploaded = 0;
  let skipped = 0;
  const failed = []; // { folderId, name, reason, job }
  let stopReason = null;

  function keysOf(folderId) {
    if (!known.has(folderId)) known.set(folderId, new Set());
    const set = known.get(folderId);
    for (const f of existing(folderId) ?? []) set.add(sameFileKey(f.name, f.size));
    return set;
  }

  /** Fotos von OneDrive (source: { id, name, size, driveId }) in den Ordner kopieren. */
  function addCopies(folderId, sources) {
    add(folderId, sources.map((source) => ({ name: source.name, size: source.size, source })));
  }

  function add(folderId, files) {
    const keys = keysOf(folderId);
    if (!running) {
      uploaded = 0;
      skipped = 0;
    }
    for (const file of files) {
      const key = sameFileKey(file.name, file.size);
      if (keys.has(key)) {
        skipped++;
        continue;
      }
      keys.add(key);
      queue.push(file.source ? { folderId, file: { name: file.name, size: file.size }, source: file.source } : { folderId, file });
    }
    stopReason = null;
    onChange();
    if (queue.length) process(); // läuft schon: weitere Helfer dazunehmen
    else if (!running) onFinished(0, skipped); // alles schon vorhanden
  }

  function retryFailed() {
    const jobs = failed.splice(0).map((f) => f.job);
    for (const j of jobs) keysOf(j.folderId).add(sameFileKey(j.file.name, j.file.size));
    if (jobs.length) {
      queue.push(...jobs);
      stopReason = null;
      if (!running) {
        uploaded = 0;
        skipped = 0;
      }
      process();
    }
    onChange();
  }

  // Nicht hochgeladen: vergessen, damit man die Datei auch neu auswählen kann (nicht als «schon vorhanden» übersprungen)
  function fail(job, reason) {
    known.get(job.folderId)?.delete(sameFileKey(job.file.name, job.file.size));
    failed.push({ folderId: job.folderId, name: job.file.name, reason, job });
  }

  function stopAll(reason, job) {
    stopReason = reason;
    for (const j of [job, ...queue.splice(0)]) fail(j, reason);
  }

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      active.set(job, { folderId: job.folderId, name: job.file.name, progress: 0, copy: !!job.source });
      onChange();
      try {
        if (job.source) {
          if (await copyOne(job)) uploaded++;
          else skipped++;
        } else {
          await drive.upload({ folderId: job.folderId, name: cleanFileName(job.file.name) }, job.file, (p) => {
            active.set(job, { ...active.get(job), progress: p });
            onChange();
          });
          uploaded++;
        }
      } catch (e) {
        console.error(e);
        if (e instanceof AuthError || e instanceof BusyError) {
          // Anmeldung abgelaufen oder kein Internet: alle restlichen warten auf «Nochmals versuchen»
          stopAll(e instanceof AuthError ? 'Anmeldung abgelaufen.' : 'Keine Verbindung zu OneDrive.', job);
        } else {
          const reason = e.status === 404 ? 'Den Ordner gibt es auf OneDrive nicht mehr.' : e.message || String(e);
          fail(job, reason);
        }
      } finally {
        active.delete(job);
        onChange();
      }
    }
  }

  /** Kopie auf OneDrive. true = kopiert, false = lag schon dort (gleicher Name + gleiche Grösse). */
  async function copyOne(job) {
    const { source, folderId } = job;
    const name = cleanFileName(source.name);
    for (let n = 0; n < 50; n++) {
      const candidate = numberedName(name, n);
      const there = await drive.itemInFolder(folderId, candidate);
      if (!there) {
        await drive.copyInto(source.id, folderId, candidate, source.driveId ?? null);
        return true;
      }
      if (source.size != null && there.size === source.size) return false;
    }
    throw new Error('Zu viele Dateien mit diesem Namen.');
  }

  // Bis zu `parallel` Helfer holen sich Dateien aus der Warteschlange; wenn der letzte fertig ist, ist alles fertig.
  let workers = 0;
  function process() {
    running = true;
    while (workers < Math.max(1, parallel) && queue.length) {
      workers++;
      worker().finally(() => {
        workers--;
        if (workers === 0) {
          running = false;
          onChange();
          onFinished(uploaded, skipped);
        }
      });
    }
  }

  return {
    add,
    addCopies,
    retryFailed,
    isRunning: () => running,
    /** Stand für die Anzeige */
    status() {
      return { running, active: [...active.values()], waiting: queue.length, uploaded, skipped, failed: [...failed], stopReason };
    },
  };
}

/** "IMG_1.jpg", 2 → "IMG_1 2.jpg" (wie OneDrive bei gleichen Namen) */
export function numberedName(name, n) {
  if (!n) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`;
}
