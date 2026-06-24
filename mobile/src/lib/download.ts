import { Platform } from 'react-native';

/** Trigger a browser file download (web only). Returns false on native or any
 *  non-DOM environment so the caller can fall back (e.g. show "use the web
 *  app"). Used for report exports the user hands to another system — e.g. the
 *  Moniepoint bulk-payout CSV the admin uploads to Moniepoint.
 *
 *  No UTF-8 BOM is added on purpose: this file targets a machine parser
 *  (Moniepoint's bulk-upload importer), and a BOM corrupts the first header
 *  cell for strict parsers. Add a BOM only for human-opened exports if needed. */
export function downloadTextFile(
  filename: string,
  content: string,
  mime = 'text/csv;charset=utf-8',
): boolean {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return true;
}
