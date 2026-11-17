// Welche Dateien sind Fotos oder Videos? (erkannt an der Endung, wie im Tourenbuch)
// RAW-Dateien (CR2, NEF …), .AAE und .XMP liegen oft neben dem JPG (Fotosortierer kopiert sie mit) – sie werden
// nicht angezeigt, sonst wäre jedes Foto doppelt.

export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif'];
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', '3gp', 'webm', 'mkv', 'avi', 'mts'];

export function extensionOf(name) {
  const n = String(name ?? '');
  return n.includes('.') ? n.split('.').pop().toLowerCase() : '';
}

export function isPhotoName(name) {
  return PHOTO_EXTENSIONS.includes(extensionOf(name));
}

export function isVideoName(name) {
  return VIDEO_EXTENSIONS.includes(extensionOf(name));
}

/** Bild (Foto) im Gegensatz z. B. zu einem PDF. */
export function isImageName(name) {
  return [...PHOTO_EXTENSIONS, 'bmp', 'tif', 'tiff'].includes(extensionOf(name));
}

export function isMediaName(name) {
  return isPhotoName(name) || isVideoName(name);
}

/** Herz gesetzt? photo.liked = { value, changed } (Daten-Datei, ab Phase 3) */
export function isLiked(photo) {
  return photo?.liked?.value === true;
}

/**
 * Aufnahmedatum aus dem Dateinamen, z. B. IMG_20200704_101112.jpg, IMG-20261018-WA0025.jpg,
 * PXL_20230101_…, Screenshot_2020-07-04 … → "2020-07-04" oder null.
 */
export function dateFromName(name) {
  const m = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/.exec(String(name ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
