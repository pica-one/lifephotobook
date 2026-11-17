// Ordnernamen für neue Ordner – Formate wie im Fotosortierer:
//   NAME        Ladina
//   JAHR_NAME   2024_Sardinien
//   DATUM_NAME  20230817_Gampel
//   JAHR        2023
//   DATUM       20250301
// Leerzeichen werden zu "_" (wie bisher), verbotene Zeichen fallen weg. Bestehende Namen werden nie geändert.

export const FORMAT_LABELS = {
  NAME: 'Name',
  JAHR_NAME: 'Jahr_Name',
  DATUM_NAME: 'JJJJMMTT_Name',
  JAHR: 'Jahr',
  DATUM: 'JJJJMMTT',
};

const MAX_SEGMENT_LENGTH = 80;
const CNTRL = /[\x00-\x1F\x7F]/g;
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul', '.lock', 'desktop.ini',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Text → gültiger Ordnername ("Südgrat: Variante A" → "Südgrat_Variante_A"); "" wenn nichts übrig bleibt. */
export function cleanSegment(text) {
  let s = String(text ?? '')
    .replace(CNTRL, ' ')
    .replace(/[/\\|]/g, ' - ')
    .replace(/[:*?"<>#%]/g, ' ')
    .replaceAll('_vti_', ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_?-_?/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/_{2,}/g, '_');
  s = s.replace(/^[_\-. ~]+|[_\-. ~]+$/g, '');
  if (s.length > MAX_SEGMENT_LENGTH) s = s.slice(0, MAX_SEGMENT_LENGTH).replace(/[_\-. ]+$/, '');
  if (RESERVED.has(s.toLowerCase())) s = `${s}_`;
  return s;
}

/** Neuer Ordnername nach Format. date: "JJJJ-MM-TT". Ergebnis "" wenn ein nötiger Teil fehlt. */
export function folderName(format, name, date) {
  const n = cleanSegment(name);
  const year = date?.slice(0, 4) ?? '';
  const ymd = date ? date.replaceAll('-', '') : '';
  switch (format) {
    case 'JAHR_NAME':
      return year && n ? `${year}_${n}` : '';
    case 'DATUM_NAME':
      return ymd && n ? `${ymd}_${n}` : '';
    case 'JAHR':
      return year;
    case 'DATUM':
      return ymd;
    default:
      return n;
  }
}

export function needsName(format) {
  return format !== 'JAHR' && format !== 'DATUM';
}

export function needsDate(format) {
  return format !== 'NAME';
}

/** Welches Format haben bestehende Ordnernamen? */
export function formatOf(name) {
  if (/^(19|20)\d{2}$/.test(name)) return 'JAHR';
  if (/^(19|20)\d{6}$/.test(name)) return 'DATUM';
  if (/^(19|20)\d{2}_./.test(name)) return 'JAHR_NAME';
  if (/^(19|20)\d{6}_./.test(name)) return 'DATUM_NAME';
  return 'NAME';
}

/**
 * Vorschlag für neue Unterordner: gemerktes Format des Ordners, sonst das häufigste der bestehenden Unterordner,
 * sonst "Name".
 */
export function suggestFormat(saved, childNames) {
  if (saved) return saved;
  const count = new Map();
  for (const n of childNames) count.set(formatOf(n), (count.get(formatOf(n)) ?? 0) + 1);
  let best = 'NAME';
  let max = 0;
  for (const [f, c] of count) if (c > max) [best, max] = [f, c];
  return best;
}

/** Name schon vergeben? (OneDrive unterscheidet Gross-/Kleinschreibung nicht) */
export function nameTaken(name, existingNames) {
  const n = name.toLowerCase();
  return existingNames.some((e) => e.toLowerCase() === n);
}

/** Dateiname für Dokumente: nur verbotene Zeichen ersetzen (sonst bleibt der Name, wie er ist). */
export function cleanFileName(name) {
  const clean = String(name ?? '').replace(CNTRL, '_').replace(/[/\\:*?"<>|]/g, '_').trim().replace(/^[. ]+|[. ]+$/g, '');
  return clean || 'Dokument';
}
