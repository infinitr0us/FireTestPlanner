import * as i18n from '../ui/i18n';
/** Shared strict quoting for measured tables and reconstruction CSV snapshots. */
export function detectDelimiter(text: string): string {
  const counts = new Map([['\t', 0], [';', 0], [',', 0]]);
  let quoted = false, nonempty = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (ch === '\r' || ch === '\n') {
        if (nonempty) break;
      } else if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
    }
    if (ch.trim()) nonempty = true;
  }
  let separator = ',', best = 0;
  for (const [candidate, count] of counts) if (count > best) { separator = candidate; best = count; }
  return separator;
}

export class DelimitedError extends Error {
  constructor(message: string, readonly line: number) { super(message); }
}

export function delimitedRows(text: string, separator = detectDelimiter(text), skipBlank: boolean | 'empty-lines' = false,
  maxRows = Infinity, lineNumbers: number[] = []): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const result: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  let line = 1, rowStart = 1, content = false;
  const pushCell = (): void => { row.push(cell.trim()); cell = ''; closed = false; };
  const pushRow = (): void => {
    pushCell();
    if (!skipBlank || (skipBlank === 'empty-lines' ? content : row.some(x => x !== ''))) {
      result.push(row); lineNumbers.push(rowStart);
    }
    row = [];
    content = false;
    if (result.length > maxRows) throw new Error(i18n.t("CSV exceeds {p1} samples.", { p1: (maxRows - 1).toLocaleString('en-US') }));
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\r' && ch !== '\n') content = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else {
        cell += ch;
        if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && text[i + 1] === '\n') { cell += '\n'; i++; }
          line++;
        }
      }
    } else if (ch === separator) pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      rowStart = ++line;
    } else if (ch === '"' && !cell.trim() && !closed) { cell = ''; quoted = true; }
    else if (ch === '"' || (closed && ch.trim())) throw new DelimitedError(i18n.t("Malformed CSV quoting."), line);
    else cell += ch;
  }
  if (quoted) throw new DelimitedError(i18n.t("CSV has an unclosed quoted field."), rowStart);
  if (cell || row.length || closed) pushRow();
  return result;
}
