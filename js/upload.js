// Fotos und Videos in ein Event (OneDrive-Ordner) hochladen – mit Fortschritt.
// Vorlage: upload.js vom Tourenbuch, vereinfacht: das Ziel ist immer ein bestehender Ordner (Kennung).
// Schneller als im Tourenbuch: bis zu 3 Dateien gleichzeitig.
// Der Dateiname bleibt (Fotos werden nie umbenannt). Liegt im Ordner schon eine Datei mit gleichem Namen
// UND gleicher Grösse, ist es dasselbe Foto → wird übersprungen. Gleicher Name, andere Grösse: OneDrive vergibt
// einen neuen Namen (z. B. "IMG_1234 1.jpg") – es wird nie etwas überschrieben.
// Die Dateien bleiben nur im Speicher: wird die Seite vorher geschlossen, müssen sie neu ausgewählt werden.

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
  const queue = []; // { folderId, file }
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
      queue.push({ folderId, file });
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
      active.set(job, { folderId: job.folderId, name: job.file.name, progress: 0 });
      onChange();
      try {
        await drive.upload({ folderId: job.folderId, name: cleanFileName(job.file.name) }, job.file, (p) => {
          active.set(job, { ...active.get(job), progress: p });
          onChange();
        });
        uploaded++;
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
    retryFailed,
    isRunning: () => running,
    /** Stand für die Anzeige */
    status() {
      return { running, active: [...active.values()], waiting: queue.length, uploaded, skipped, failed: [...failed], stopReason };
    },
  };
}
