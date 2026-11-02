/** Cached-value OOXML reader (.xlsx/.xlsm), DOM-free and dependency-free.
 * ZIP listing is lazy: unrelated sheets, styles, images and VBA are never inflated.
 */
import { listZip, type ZipEntry } from './flame';
import { channelUnits, makeGrid, numericCell, type Cell, type CellError, type Grid } from './tables';

type Event = { kind: 'start' | 'end' | 'text'; name: string; attrs: Record<string, string>; text: string };
const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

function entities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity];
  });
}

/** Only the XML constructs needed by SpreadsheetML; no DTD or entity expansion. */
function* xmlEvents(xml: string): Generator<Event> {
  const stack: string[] = [];
  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      let end = xml.indexOf('<', i); if (end < 0) end = xml.length;
      yield { kind: 'text', name: '', attrs: {}, text: entities(xml.slice(i, end).replace(/\r\n?/g, '\n')) };
      i = end; continue;
    }
    let terminator = '', skip = 0;
    if (xml.startsWith('<!--', i)) { terminator = '-->'; skip = 4; }
    else if (xml.startsWith('<?', i)) { terminator = '?>'; skip = 2; }
    else if (xml.startsWith('<![CDATA[', i)) { terminator = ']]>'; skip = 9; }
    if (terminator) {
      const end = xml.indexOf(terminator, i + skip);
      if (end < 0) throw new Error('Malformed workbook XML.');
      if (skip === 9) yield { kind: 'text', name: '', attrs: {}, text: xml.slice(i + skip, end).replace(/\r\n?/g, '\n') };
      i = end + terminator.length; continue;
    }
    if (xml.startsWith('<!', i)) throw new Error('Workbook XML declarations are not supported.');
    let end = i + 1, quote = '';
    for (; end < xml.length; end++) {
      const ch = xml[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end === xml.length) throw new Error('Malformed workbook XML.');
    const body = xml.slice(i + 1, end), closing = body.startsWith('/'), self = /\/\s*$/.test(body);
    const match = /^\/?([A-Za-z_][\w.:-]*)/.exec(body);
    if (!match) throw new Error('Malformed workbook XML.');
    const full = match[1], name = localName(full), attrs: Record<string, string> = {};
    if (closing) {
      if (stack.pop() !== full) throw new Error('Malformed workbook XML.');
      yield { kind: 'end', name, attrs, text: '' };
    } else {
      for (const a of body.slice(match[0].length).matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = entities((a[2] ?? a[3]).replace(/[\r\n\t]/g, ' '));
      yield { kind: 'start', name, attrs, text: '' };
      if (self) yield { kind: 'end', name, attrs: {}, text: '' };
      else stack.push(full);
    }
    i = end + 1;
  }
  if (stack.length) throw new Error('Malformed workbook XML.');
}

async function part(entries: Map<string, ZipEntry>, name: string): Promise<string> {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Workbook is missing ${name}.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(await entry.extract());
}
async function archive(bytes: Uint8Array): Promise<Map<string, ZipEntry>> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) throw new Error('.xls is not supported; save as .xlsx or .csv.');
  const entries = listZip(bytes);
  if (entries.has('mimetype') && (await part(entries, 'mimetype')).trim() === 'application/vnd.oasis.opendocument.spreadsheet') throw new Error('.ods is not supported; save as .xlsx or .csv.');
  return entries;
}
async function sheets(entries: Map<string, ZipEntry>): Promise<{ name: string; id: string }[]> {
  const result: { name: string; id: string }[] = [];
  for (const e of xmlEvents(await part(entries, 'xl/workbook.xml'))) {
    if (e.kind === 'start' && e.name === 'sheet') result.push({ name: e.attrs.name, id: Object.entries(e.attrs).find(([key]) => localName(key) === 'id')?.[1] ?? '' });
  }
  return result;
}
export async function listSheets(bytes: Uint8Array): Promise<string[]> {
  return (await sheets(await archive(bytes))).map(sheet => sheet.name);
}

function targetPart(target: string): string {
  target = decodeURIComponent(target);
  if (/[\\?#]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) throw new Error('External worksheet relationships are not supported.');
  const parts: string[] = [];
  for (const segment of (target.startsWith('/') ? target : `xl/${target}`).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!parts.length) throw new Error('Invalid worksheet part path.'); parts.pop(); }
    else parts.push(segment);
  }
  return parts.join('/');
}

function sharedStrings(xml: string): string[] {
  const result: string[] = [];
  let inString = false, inText = false, phonetic = false, value = '';
  for (const e of xmlEvents(xml)) {
    if (e.kind === 'start') {
      if (e.name === 'si') { inString = true; value = ''; }
      if (e.name === 'rPh') phonetic = true;
      if (e.name === 't') inText = true;
    } else if (e.kind === 'end') {
      if (e.name === 'si') { result.push(value); inString = false; }
      if (e.name === 'rPh') phonetic = false;
      if (e.name === 't') inText = false;
    } else if (inString && inText && !phonetic) value += e.text;
  }
  return result;
}

/** Dense output necessarily allocates rows x columns. Refuse pathological bounds. */
const MAX_CELLS = 10_000_000;
function sheetGrid(xml: string, shared: string[]): Grid {
  const rows: Cell[][] = [], errors: CellError[] = [];
  let row = 0, column = -1, width = 0, type = '', value = '', inline = '';
  let inCell = false, inValue = false, inText = false, phonetic = false, inData = false;
  const extend = (r: number, c: number): void => {
    width = Math.max(width, c + 1);
    if (!Number.isInteger(r) || r < 1 || r > 1_048_576 || c < 0 || c >= 16_384 || Math.max(r, rows.length) * width > MAX_CELLS) throw new Error('Worksheet exceeds the 10,000,000-cell dense grid limit or has invalid coordinates.');
    while (rows.length < r) rows.push([]);
    while (rows[r - 1].length <= c) rows[r - 1].push(null);
  };
  for (const e of xmlEvents(xml)) {
    if (e.kind === 'start') {
      if (e.name === 'sheetData') inData = true;
      if (!inData) continue;
      if (e.name === 'row') { row = e.attrs.r ? Number(e.attrs.r) : row + 1; column = -1; extend(row, 0); }
      if (e.name === 'c') {
        inCell = true; type = e.attrs.t ?? ''; value = ''; inline = '';
        if (e.attrs.r) {
          const ref = /^([A-Z]+)([1-9]\d*)$/i.exec(e.attrs.r);
          if (!ref) throw new Error('Invalid worksheet cell reference.');
          column = 0;
          for (const ch of ref[1].toUpperCase()) column = column * 26 + ch.charCodeAt(0) - 64;
          column--; row = Number(ref[2]);
        } else column++;
        extend(row, column);
      }
      if (inCell && e.name === 'v') inValue = true;
      if (inCell && e.name === 't') inText = true;
      if (inCell && e.name === 'rPh') phonetic = true;
    } else if (e.kind === 'text') {
      if (inValue) value += e.text;
      if (inText && !phonetic) inline += e.text;
    } else {
      if (e.name === 'sheetData') inData = false;
      if (e.name === 'v') inValue = false;
      if (e.name === 't') inText = false;
      if (e.name === 'rPh') phonetic = false;
      if (e.name === 'c' && inCell) {
        let cell: Cell = null;
        if (type === 'e') errors.push({ row, column, code: value.trim() || '#ERROR!' });
        else if (type === 'inlineStr') cell = inline || null;
        else if (type === 'str' || type === 'd') cell = value || null;
        else if (type === 's') {
          const index = numericCell(value);
          if (index === null || !Number.isInteger(index) || index < 0 || index >= shared.length) throw new Error('Invalid shared string index.');
          cell = shared[index] || null;
        } else if (type === 'b') cell = value.trim() === '1' ? 1 : value.trim() === '0' ? 0 : null;
        else cell = numericCell(value);
        rows[row - 1][column] = cell; inCell = false;
      }
    }
  }
  errors.sort((a, b) => a.row - b.row || a.column - b.column);
  return makeGrid(rows, errors);
}

async function relationships(entries: Map<string, ZipEntry>): Promise<Map<string, Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  for (const e of xmlEvents(await part(entries, 'xl/_rels/workbook.xml.rels'))) {
    if (e.kind === 'start' && e.name === 'Relationship') result.set(e.attrs.Id, e.attrs);
  }
  return result;
}

async function readPart(entries: Map<string, ZipEntry>, sheet: { name: string; id: string }, rels: Map<string, Record<string, string>>, shared: string[]): Promise<Grid> {
  const rel = rels.get(sheet.id);
  if (!rel?.Target) throw new Error(`Sheet "${sheet.name}" has no worksheet relationship.`);
  if (rel.TargetMode === 'External') throw new Error('External worksheet relationships are not supported.');
  return sheetGrid(await part(entries, targetPart(rel.Target)), shared);
}

export async function readSheet(bytes: Uint8Array, sheetName: string): Promise<Grid> {
  const entries = await archive(bytes), sheet = (await sheets(entries)).find(s => s.name === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" was not found.`);
  const rels = await relationships(entries);
  const shared = entries.has('xl/sharedStrings.xml') ? sharedStrings(await part(entries, 'xl/sharedStrings.xml')) : [];
  return readPart(entries, sheet, rels, shared);
}

/** Merge metadata tables in workbook order; retain only one sheet grid at a time. */
export async function workbookChannelUnits(bytes: Uint8Array): Promise<Map<string, string>> {
  const entries = await archive(bytes), ordered = await sheets(entries), rels = await relationships(entries);
  const shared = entries.has('xl/sharedStrings.xml') ? sharedStrings(await part(entries, 'xl/sharedStrings.xml')) : [];
  const result = new Map<string, string>();
  for (const sheet of ordered) {
    for (const [name, raw] of channelUnits(await readPart(entries, sheet, rels, shared))) result.set(name, raw);
  }
  return result;
}
