/**
 * File validation shared by visitor uploads and staff files from Slack.
 */

import { ALLOWED_FILE_TYPES } from './config';

/** Maps aliases to the canonical MIME type. Returns undefined for types that are not allowed. */
export function normalizeMimeType(mimeType: unknown): string | undefined {
  if (typeof mimeType !== 'string') return undefined;
  const type = mimeType.split(';')[0].trim().toLowerCase();
  const canonical = type === 'image/jpg' ? 'image/jpeg' : type;
  // hasOwn, not `in`: "constructor" or "__proto__" must not count as allowed types
  return Object.hasOwn(ALLOWED_FILE_TYPES, canonical) ? canonical : undefined;
}

/**
 * Makes a filename safe to store and show: strips paths, control and special characters,
 * and forces the extension to match the MIME type, so `invoice.pdf.exe` cannot pass as a PDF.
 */
export function sanitizeFilename(filename: string, mimeType: string): string {
  const extension = ALLOWED_FILE_TYPES[mimeType] ?? 'bin';
  let name = filename
    .split(/[/\\]/)
    .pop()!
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  const hasExpectedExtension = (value: string) => {
    const dot = value.lastIndexOf('.');
    const current = dot > 0 ? value.slice(dot + 1).toLowerCase() : '';
    return current === extension || (extension === 'jpg' && current === 'jpeg');
  };
  if (!hasExpectedExtension(name)) {
    // Drop a wrong last extension ("invoice.pdf.exe" -> "invoice.pdf"), then append the right one if needed
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    name = hasExpectedExtension(base) ? base : `${base || 'file'}.${extension}`;
  }

  if (name.length > 120) {
    const suffix = name.slice(name.lastIndexOf('.'));
    name = name.slice(0, 120 - suffix.length) + suffix;
  }
  return name;
}

/** `Content-Disposition` value with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Checks the first bytes of a file against its declared type, so a script or executable
 * cannot be uploaded as an "image". Plain text must not contain NUL bytes.
 */
export function contentMatchesType(mimeType: string, head: Uint8Array): boolean {
  const startsWith = (...bytes: number[]) => bytes.every((byte, i) => head[i] === byte);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, i) => head[offset + i] === char.charCodeAt(0));

  switch (mimeType) {
    case 'image/jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/gif':
      return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
    case 'image/webp':
      return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'application/pdf':
      return ascii(0, '%PDF-');
    case 'text/plain':
      return !head.includes(0);
    default:
      return false;
  }
}

/** R2 key for a file. The filename is kept in the object's metadata, not in the key. */
export function fileKey(sessionName: string, fileId: string): string {
  return `${sessionName}/${fileId}`;
}
