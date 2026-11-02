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

export function delimitedRows(text: string, separator = detectDelimiter(text), skipBlank = false, maxRows = Infinity): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const result: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const pushCell = (): void => { row.push(cell.trim()); cell = ''; closed = false; };
  const pushRow = (): void => {
    pushCell();
    if (!skipBlank || row.some(x => x !== '')) result.push(row);
    row = [];
    if (result.length > maxRows) throw new Error(i18n.t("CSV exceeds {p1} samples.", { p1: (maxRows - 1).toLocaleString('en-US') }));
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += ch;
    } else if (ch === separator) pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else if (ch === '"' && !cell.trim() && !closed) { cell = ''; quoted = true; }
    else if (ch === '"' || (closed && ch.trim())) throw new Error(i18n.t("Malformed CSV quoting."));
    else cell += ch;
  }
  if (quoted) throw new Error(i18n.t("CSV has an unclosed quoted field."));
  if (cell || row.length || closed) pushRow();
  return result;
}
