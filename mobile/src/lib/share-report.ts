/** Maximum size of the complete text handed to the receiving app. */
export const SHARE_PART_MAX_BYTES = 3500;

export type ShareReport = { header: string; blocks: string[]; footer: string };
export type SharePart = { text: string; bytes: number };

/** Matches UTF-8 encoding (including replacement of unpaired surrogates).
 * No TextEncoder/Buffer dependency: also works in the Android JS runtime. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function reportText(report: ShareReport): string {
  return [report.header, ...report.blocks, report.footer].join('\n\n');
}

/** Split one unusually large block without dropping whitespace or Unicode
 * code points. Prefer complete lines, then words, then code-point boundaries. */
function splitBlock(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    let line = start;
    let word = start;
    while (end < text.length) {
      const code = text.codePointAt(end)!;
      const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + size > budget) break;
      bytes += size;
      const char = text[end]!;
      end += code > 0xffff ? 2 : 1;
      if (char === '\n') line = end;
      if (/\s/.test(char)) word = end;
    }
    if (end === start) throw new Error('The report heading leaves no room for the update.');
    // Avoid tiny fragments when the only whitespace is near the start.
    const halfway = start + (end - start) / 2;
    const cut = end === text.length ? end : line > halfway ? line : word > halfway ? word : end;
    pieces.push(text.slice(start, cut));
    start = cut;
  }
  return pieces;
}

/** Pack structured orders, preserving their order and one final totals block.
 * Only oversized individual blocks need splitting. Size calculations include
 * headers, continuation labels, separators and the final part-number width.
 * Work is linear in report size per digit-width pass (normally just one). */
export function splitShareReport(
  report: ShareReport,
  maxBytes = SHARE_PART_MAX_BYTES,
): SharePart[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid share size.');
  const full = reportText(report);
  const fullBytes = utf8Bytes(full);
  if (fullBytes <= maxBytes) return [{ text: full, bytes: fullBytes }];
  const continuation = '(continued)\n';
  const continuationBytes = utf8Bytes(continuation);
  const blocks = [...report.blocks, report.footer].map((text) => ({
    text,
    bytes: utf8Bytes(text),
  }));
  let digits = 1;
  for (;;) {
    const widest = '9'.repeat(digits);
    const overhead = utf8Bytes(report.header + '\nPart ' + widest + ' of ' + widest + '\n\n');
    const budget = maxBytes - overhead;
    if (budget < continuationBytes + 4) {
      throw new Error('The report heading is too long to share. Please shorten the client name.');
    }
    const bodies: string[] = [];
    let current: string[] = [];
    let used = 0;
    const flush = () => {
      if (current.length) bodies.push(current.join('\n\n'));
      current = [];
      used = 0;
    };
    for (const block of blocks) {
      if (block.bytes > budget) {
        flush();
        // Reserve the continuation label for every fragment; never overflow it.
        const pieces = splitBlock(block.text, budget - continuationBytes);
        pieces.forEach((piece, index) => bodies.push((index ? continuation : '') + piece));
        continue;
      }
      const separator = current.length ? 2 : 0;
      if (used + separator + block.bytes > budget) flush();
      used += (current.length ? 2 : 0) + block.bytes;
      current.push(block.text);
    }
    flush();
    const requiredDigits = String(bodies.length).length;
    if (requiredDigits > digits) {
      digits = requiredDigits;
      continue;
    }
    return bodies.map((body, index) => {
      const text = report.header + '\nPart ' + (index + 1) + ' of ' + bodies.length + '\n\n' + body;
      return { text, bytes: utf8Bytes(text) };
    });
  }
}
