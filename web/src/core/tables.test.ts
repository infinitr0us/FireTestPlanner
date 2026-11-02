import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { listSheets, readSheet, workbookChannelUnits } from './xlsx';
import { calibrationHint, channelUnits, detectShape, extractSeries, makeGrid, readDelimited, timeShiftHint, type Cell } from './tables';
import { listZip, readZip } from './flame';

const folder = fileURLToPath(new URL('../../../fixtures/test-data/', import.meta.url));
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** Tiny valid ZIP writer for reader tests; compression/build time is not timed. */
function zip(entries: Record<string, string>, unsupported = ''): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const source = Buffer.from(text), raw = deflateRawSync(source), filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const b of source) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name === unsupported ? 99 : 8, 8);
    local.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
    local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(filename.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(name === unsupported ? 99 : 8, 10);
    dir.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 16);
    dir.writeUInt32LE(raw.length, 20); dir.writeUInt32LE(source.length, 24);
    dir.writeUInt16LE(filename.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, filename, raw); central.push(dir, filename);
    offset += local.length + filename.length + raw.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function workbook(xml: string, shared?: string, extra: Record<string, string> = {}, unsupported = ''): Uint8Array {
  return zip({
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Log &amp; more" sheetId="7" r:id="r7"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r7" Target="/xl/worksheets/custom.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/custom.xml': `<worksheet xmlns="${ns}"><sheetData>${xml}</sheetData></worksheet>`,
    ...(shared === undefined ? {} : { 'xl/sharedStrings.xml': `<sst xmlns="${ns}">${shared}</sst>` }), ...extra,
  }, unsupported);
}

function column(n: number): string {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

function close(actual: unknown, expected: unknown): void {
  if (typeof expected === 'number') {
    expect(typeof actual).toBe('number');
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-12);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true); expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((v, i) => close((actual as unknown[])[i], v));
  } else if (expected !== null && typeof expected === 'object') {
    expect(Object.keys(actual as object).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) close((actual as Record<string, unknown>)[key], value);
  } else expect(actual).toEqual(expected);
}

describe('OOXML cached cells', () => {
  it('maps sheet relationships, entities, rich and inline text, cached formulas, booleans and sparse references', async () => {
    const bytes = workbook('<row r="12"><c r="AB12"><v> 5.0010080E+000</v></c><c r="A12" t="s"><v>0</v></c><c r="C12" t="inlineStr"><is><t xml:space="preserve"> x &lt; &#x3b1; &quot; &#39; </t></is></c><c r="D12" t="str"><f>ignored()</f><v>A&amp;B</v></c><c r="E12" t="b"><v>1</v></c><c r="F12" t="b"><v>0</v></c><c r="G12"><f>1+1</f><v>2</v></c><c r="H12"><f>1+1</f></c></row><row r="2"><c r="B2"><v>-2e-3</v></c></row>',
      '<si><r><t xml:space="preserve"> rich </t></r><r><t>&amp; text</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>');
    expect(await listSheets(bytes)).toEqual(['Log & more']);
    const grid = await readSheet(bytes, 'Log & more');
    expect(grid.length).toBe(12); expect(grid.every(r => r.length === 28)).toBe(true);
    expect(grid[0].every(v => v === null)).toBe(true); expect(grid[1][1]).toBe(-0.002);
    expect(grid[11].slice(0, 8)).toEqual([' rich & text', null, ' x < α " \' ', 'A&B', 1, 0, 2, null]);
    expect(grid[11][27]).toBe(5.001008);
  });

  it('records error addresses separately and accepts an absent sharedStrings part', async () => {
    const grid = await readSheet(workbook('<row r="1"><c r="A1" t="e"><v>#NUM!</v></c><c r="B1" t="e"><v>#DIV/0!</v></c><c r="C1" t="e"><v>#N/A</v></c><c r="D1" t="e"><v>#VALUE!</v></c></row>'), 'Log & more');
    expect(Array.from(grid)).toEqual([[null, null, null, null]]);
    expect(grid.errors).toEqual(['#NUM!', '#DIV/0!', '#N/A', '#VALUE!'].map((code, column) => ({ row: 1, column, code })));
    await expect(readSheet(workbook(''), 'missing')).rejects.toThrow('Sheet "missing" was not found.');
  });

  it('lists lazily and never extracts an unrelated sheet or a macro part', async () => {
    const bytes = workbook('<row r="1"><c r="A1"><v>42</v></c></row>', undefined, { 'xl/unused.xml': 'unread', 'xl/vbaProject.bin': 'opaque VBA, never executed' }, 'xl/unused.xml');
    expect([...listZip(bytes).keys()]).toContain('xl/unused.xml');
    expect(await listSheets(bytes)).toEqual(['Log & more']);
    expect((await readSheet(bytes, 'Log & more'))[0][0]).toBe(42);
    await expect(readZip(bytes)).rejects.toThrow('unsupported compression method');
  });

  it('handles prefixed XML, relative relationship targets and XML lexical details', async () => {
    const bytes = zip({
      'xl/workbook.xml': '<x:workbook xmlns:x="urn:sheet" xmlns:r="urn:rel"><x:sheets><x:sheet name="A &gt; B" r:id="second"/></x:sheets></x:workbook>',
      'xl/_rels/workbook.xml.rels': '<r:Relationships xmlns:r="urn:rel"><r:Relationship Id="second" Target="worksheets/../worksheets/custom%20name.xml"/></r:Relationships>',
      'xl/worksheets/custom name.xml': '<x:worksheet xmlns:x="urn:sheet"><!-- ignored <row> --><x:sheetData><x:row r="1"><x:c r="B1" t="inlineStr"><x:is><x:r><x:t xml:space="preserve"><![CDATA[ a > b & c ]]></x:t></x:r><x:r><x:t> tail</x:t></x:r></x:is></x:c><x:c r="A1" t="str"><x:v>&amp;lt;</x:v></x:c><x:c r="C1"/></x:row><x:row r="3"/></x:sheetData></x:worksheet>',
    });
    expect(await listSheets(bytes)).toEqual(['A > B']);
    expect(Array.from(await readSheet(bytes, 'A > B'))).toEqual([['&lt;', ' a > b & c  tail', null], [null, null, null], [null, null, null]]);
  });

  it('refuses impossible dense bounds and dangling shared string references', async () => {
    await expect(readSheet(workbook('<row r="1"><c r="XFD1048576"><v>1</v></c></row>'), 'Log & more')).rejects.toThrow('dense grid limit');
    await expect(readSheet(workbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'), 'Log & more')).rejects.toThrow('Invalid shared string index.');
  });

  it('refuses legacy XLS and ODS with a conversion instruction', async () => {
    for (const [bytes, format] of [[new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), '.xls'], [zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet' }), '.ods']] as const) {
      await expect(listSheets(bytes)).rejects.toThrow(`${format} is not supported; save as .xlsx or .csv.`);
      await expect(readSheet(bytes, 'Log')).rejects.toThrow(`${format} is not supported; save as .xlsx or .csv.`);
    }
  });

  it('reads a 5,000 by 60 sheet in under 3 seconds', async () => {
    const xml = Array.from({ length: 5000 }, (_, i) => `<row r="${i + 1}">${Array.from({ length: 60 }, (_, j) => `<c r="${column(j)}${i + 1}"><v>${i * 60 + j}</v></c>`).join('')}</row>`).join('');
    const bytes = workbook(xml), start = performance.now();
    const grid = await readSheet(bytes, 'Log & more');
    const elapsed = performance.now() - start;
    expect(grid.length).toBe(5000); expect(grid[4999][59]).toBe(299999);
    expect(elapsed).toBeLessThan(3000);
    console.info(`OOXML 5000 x 60: ${elapsed.toFixed(0)} ms`);
  }, 20000);
});

describe('delimited tables and extraction', () => {
  const mixed: Cell[][] = [
    ['Time', 'ELAPSED TIME', 'Duct oxygen', 'Gauge_23.17kW/m2permV', 'Gauge_23.17kW/m2permV', 'Free_0r', 'Free_0r', 'Free_0r', null],
    ['From ignition', '[sec]', 'Volt', '[V]', '[kW/m2]', 'Duct temp', 'Air velocity', 'Duct temp', '[MJ]'],
    [null, 120, '(0.7, 20.9)', null, 'Calculated', '[ºC]', '[m/s]', '[C]', null],
    ['[mim]', 'shft time', null, 0.72, null, 'T', 'Vel', 'm', null],
    [-2, -120, 2, 0.001, 23.17, 21, 1, 22, 0],
    [-1, -60, 2.1, 0.002, 42.88, 22, 2, 23, 1],
    [0, 0, 2.2, 0.003, 64.32, 23, 3, 24, 2],
  ];

  it('finds metadata tables below other tables, stops at blank rows and supplies only missing units', async () => {
    const metadata: Cell[][] = [['Property', 'Value'], ['Source', 'Invented'], [], ['Datatype', 'cHaNnEl', 'UNIT'], ['Double', 'Gauge', 'Volts'], ['Double', 'Probe', 'ºC'], [], ['Double', 'Ignored', 'A']];
    const units = channelUnits(metadata);
    expect([...units]).toEqual([['Gauge', 'Volts'], ['Probe', 'ºC']]);
    const logger = [['Gauge_Time', 'Gauge', 'Probe_Time', 'Probe'], [0, 1, 0, 2], [1, 3, 1, 4]];
    const channels = extractSeries(logger, detectShape(logger), units).channels;
    expect(channels.map(c => [c.unit, c.rawUnit])).toEqual([['V', 'Volts'], ['°C', 'ºC']]);
    expect(extractSeries([['Time', 'Gauge'], ['s', '[kW/m2]'], [0, 1]], { shape: 'plain', headerRow: 1, unitsRow: 2, dataRow: 3, timeColumn: 0 }, units).channels[0].unit).toBe('kW/m2');
    const bytes = workbook('<row r="3"><c r="B3" t="inlineStr"><is><t>Channel</t></is></c><c r="D3" t="inlineStr"><is><t>Unit</t></is></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>Gauge</t></is></c><c r="D4" t="inlineStr"><is><t>V</t></is></c></row>');
    expect([...await workbookChannelUnits(bytes)]).toEqual([['Gauge', 'V']]);
  });

  it('composes processed names and raw/normalized units per column and chooses seconds', () => {
    const layout = detectShape(mixed), result = extractSeries(mixed, layout);
    expect(layout.shape).toBe('processed'); expect(layout.dataRow).toBe(5); expect(layout.timeColumn).toBe(1);
    expect(result.channels.map(c => [c.name, c.unit, c.rawUnit])).toEqual([
      ['Time', 'mim', '[mim]'], ['Duct oxygen', 'V', 'Volt'],
      ['Gauge_23.17kW/m2permV [V]', 'V', '[V]'], ['Gauge_23.17kW/m2permV [kW/m2]', 'kW/m2', '[kW/m2]'],
      ['Duct temp', '°C', '[ºC]'], ['Air velocity', 'm/s', '[m/s]'], ['Duct temp#2', '°C', '[C]'], ['Column I', 'MJ', '[MJ]'],
    ]);
    expect(result.channels.every(c => c.t[0] === -120 && c.t[2] === 0)).toBe(true);
    const grid: Cell[][] = [['Time', 'Elapsed', 'Value'], ['[mim]', '[sec]', '[V]'], ['note'], [-1, -60, 2], [0, 0, 3]];
    expect(detectShape(grid).timeColumn).toBe(1);
    expect(extractSeries([['Time', 'Calculated', 'Free_0'], [0, 1, 2]], detectShape([['Time', 'Calculated', 'Free_0'], [0, 1, 2]])).channels.map(c => c.name)).toEqual(['Calculated', 'Free_0']);
  });

  it('finds orthogonal header shift hints, refuses ambiguity, and excludes data cells', () => {
    expect(timeShiftHint(mixed)).toEqual({ seconds: 120, row: 3, column: 1 });
    expect(timeShiftHint([['offset', 12], ['description', 'text']])).toEqual({ seconds: 12, row: 1, column: 1 });
    expect(timeShiftHint([['ignition at', 'other'], [30, null]])).toEqual({ seconds: 30, row: 2, column: 0 });
    expect(timeShiftHint([[12, 'shift', 12]])).toEqual({ seconds: 12, row: 1, column: 0 });
    expect(timeShiftHint([[12, 'shift', 13]])).toBeNull();
    const ambiguous = mixed.map(row => [...row]); ambiguous[3][2] = 0.72;
    expect(timeShiftHint(ambiguous)).toBeNull();
    expect(timeShiftHint([['Time', 'offset'], [0, 10], [1, 20]])).toBeNull();
    expect(timeShiftHint([['Time', 'Value'], [0, 1]])).toBeNull();
  });

  it('gates calibration on the input unit and collapses all-dropped sheet warnings', () => {
    const name = 'Gauge_23.17kW/m2permV';
    for (const unit of ['V', 'Volt', 'Volts', '[V]', null]) expect(calibrationHint(name, unit)).toEqual({ scale: 23170, unit: 'kW/m2', inputUnit: 'V' });
    expect(calibrationHint(name, 'mV')).toEqual({ scale: 23.17, unit: 'kW/m2', inputUnit: 'mV' });
    for (const unit of ['kW/m2', '[kW/m²]', 'C', 'A', 'mim']) expect(calibrationHint(name, unit)).toBeNull();
    for (const grid of [[], [['Constants', 'Name', 'Value'], ['gain', 'Made up', 3]], [['Time', 'X', 'Y'], [0, null, null]]]) {
      expect(extractSeries(grid, detectShape(grid))).toEqual({ channels: [], warnings: ['No time series on this sheet.'] });
    }
  });

  it('keeps raw unit spelling, repeated unit tokens, and collision-free unit labels', () => {
    const grid: Cell[][] = [
      ['Time', 'Gauge', 'Gauge', null, 'Gauge [V]', 'Free_0', 'Free_0', 'Free_0'],
      ['[sec]', '[V]', 'Volts', '[kW/m2]', '[V]', 'mass', 'gas', 'power'],
      [null, '  V  ', 'V', 'Gauge', 'V', '[kg/s]', '[%Vol]', 'kW/m²'],
      [0, 1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7, 8],
    ];
    const channels = extractSeries(grid, detectShape(grid)).channels;
    expect(channels.map(c => c.name)).toEqual(['Gauge [V]#2', 'Gauge [V]#3', 'Gauge [kW/m2]', 'Gauge [V]', 'mass', 'gas', 'power']);
    expect(channels.map(c => c.unit)).toEqual(['V', 'V', 'kW/m2', 'V', 'kg/s', '%Vol', 'kW/m²']);
    const raw = extractSeries([['Time', 'Probe'], ['s', '  Volts  '], [0, 1]], { shape: 'plain', headerRow: 1, unitsRow: 2, dataRow: 3, timeColumn: 0 }).channels[0];
    expect([raw.unit, raw.rawUnit]).toEqual(['V', '  Volts  ']);
    expect([...channelUnits([['Channel', 'Unit'], ['a', 'V'], [], ['channel', 'unit'], ['a', 'mV'], ['b', 'A'], []])]).toEqual([['a', 'mV'], ['b', 'A']]);
  });

  it('shares quoting and delimiter detection, preserves blank rows and pads sparse rows', () => {
    expect(Array.from(readDelimited('\ufeff"Time";"a,b";"say ""hi"""\r\n 5.0010080E+000;2;\r\n\r\n6;"x;y";"line\nnext"'))).toEqual([
      ['Time', 'a,b', 'say "hi"'], [5.001008, 2, null], [null, null, null], [6, 'x;y', 'line\nnext'],
    ]);
    expect(Array.from(readDelimited('t\tx\n0\t1\n1'))).toEqual([['t', 'x'], [0, 1], [1, null]]);
    expect(Array.from(readDelimited('t,x\n0,0x10\n1,Infinity'))).toEqual([['t', 'x'], [0, '0x10'], [1, 'Infinity']]);
    expect(() => readDelimited('a,b\n"unclosed')).toThrow('unclosed');
    expect(() => readDelimited('a,b\n"x"z,2')).toThrow('Malformed');
  });

  it('detects all shapes and prefers seconds without converting the numbers', () => {
    expect(detectShape([['a_Time*', 'a', 'b_Time', 'b'], [0, 1, 0, 2]])).toEqual({ shape: 'paired-time', headerRow: 1, unitsRow: null, dataRow: 2, timeColumn: null });
    expect(detectShape([['s', 'kW'], ['Time', 'HRR'], [0, 1]])).toEqual({ shape: 'fds', headerRow: 2, unitsRow: 1, dataRow: 3, timeColumn: 0 });
    const grid: Cell[][] = [['group', 'Free_0', 'Free_0'], ['Time [min]', 'Time [sec]', 'HF'], ['[min]', '[s]', '[kW/m2]'], ['[min] | shift'], [-1, -60, 0], [0, 0, 1], [0, 0, 2]];
    expect(detectShape(grid)).toEqual({ shape: 'processed', headerRow: 2, unitsRow: 3, dataRow: 5, timeColumn: 1 });
    const layout = detectShape([['index', 'Time', 'a'], [0, -1, 1], [1, 0, 2]]);
    expect(layout).toEqual({ shape: 'plain', headerRow: 1, unitsRow: null, dataRow: 2, timeColumn: 1 });
    expect(detectShape([])).toEqual({ shape: 'plain', headerRow: 1, unitsRow: null, dataRow: 2, timeColumn: 0 });
  });

  it('skips missing time/value, tracks time across missing values, stops once and drops empty channels', () => {
    const grid: Cell[][] = [['Time', 'A', 'A', 'Empty'], [0, 10, null, null], [1, null, 20, null], [null, 99, 99, null], [2, 12, 22, null], [2, 40, 50, null], [3, 41, 51, null]];
    const result = extractSeries(grid, detectShape(grid));
    expect(result.channels).toEqual([
      { name: 'A', unit: null, rawUnit: null, column: 1, t: [0, 2], values: [10, 12], missing: 2 },
      { name: 'A#2', unit: null, rawUnit: null, column: 2, t: [1, 2], values: [20, 22], missing: 2 },
    ]);
    expect(result.warnings).toEqual(['Time column A stops increasing at sheet row 6; series ended.', 'Duplicate channel name "A" renamed to "A#2".', 'Channel "Empty" has no numeric samples and was dropped.']);
    const paired: Cell[][] = [['a_Time', 'a', 'b_Time*', 'b'], [0, 1, 10, 3], [0, 2, 11, 4], [1, 3, 12, 5]];
    const own = extractSeries(paired, detectShape(paired));
    expect(own.channels.map(c => c.t)).toEqual([[0], [10, 11, 12]]);
    expect(own.warnings).toEqual(['Time column A stops increasing at sheet row 3; series ended.']);
    expect(extractSeries([['Time', 'A'], [0, null], [0, 2]], { shape: 'plain', headerRow: 1, unitsRow: null, dataRow: 2, timeColumn: 0 }).channels).toEqual([]);
  });

  it('states the calibration input-unit assumption and leaves ordinary names alone', () => {
    for (const name of ['HF_23.17kW/m2permV', '23.17 kW/m2 per mV']) expect(calibrationHint(name, null)).toEqual({ scale: 23170, unit: 'kW/m2', inputUnit: 'V' });
    expect(calibrationHint('TC 23.17 C', null)).toBeNull();
    expect(calibrationHint('HF_-23.17kW/m2permV', null)).toBeNull();
    expect(calibrationHint('HF_23.17kW/m2permV_extra', null)).toEqual({ scale: 23170, unit: 'kW/m2', inputUnit: 'V' });
    expect(calibrationHint('HF_23.17\u0085kW/m2permV', null)).toBeNull();
  });

  it('allows time overrides, recognizes a simple units row and avoids suffix collisions', () => {
    const grid: Cell[][] = [['Time minutes', 'Time alternate', 'q', 'q', 'q#2'], ['min', 'seconds', 'kW', 'kW', 'kW'], [0, 0, 1, 2, 3], [1, 60, 4, 5, 6]];
    const layout = detectShape(grid);
    expect(layout).toEqual({ shape: 'plain', headerRow: 1, unitsRow: 2, dataRow: 3, timeColumn: 1 });
    const result = extractSeries(grid, { ...layout, timeColumn: 0 });
    expect(result.channels.map(c => c.name)).toEqual(['Time alternate', 'q', 'q#3', 'q#2']);
    expect(result.channels.every(c => c.t[1] === 1)).toBe(true);
    expect(result.channels[0].unit).toBe('seconds');
    expect(result.warnings).toEqual(['Duplicate channel name "q" renamed to "q#3".']);
    expect(detectShape([['a', 'b_Time', 'b', 'noise', 'more', 'extra'], [0, 0, 1, 2, 3, 4]]).shape).toBe('plain');
  });

  it('reports error addresses, is pure, and counts an error time as missing', () => {
    const grid = makeGrid([['Time', 'Value'], [0, 1], [null, 2], [2, null], [1, 4]], [{ row: 3, column: 0, code: '#N/A' }, { row: 4, column: 1, code: '#VALUE!' }]);
    const before = JSON.stringify(grid), layout = detectShape(grid);
    const result = extractSeries(grid, layout);
    expect(result.channels[0]).toEqual({ name: 'Value', unit: null, rawUnit: null, column: 1, t: [0], values: [1], missing: 2 });
    expect(result.warnings).toEqual(['Cell A3: #N/A treated as missing.', 'Cell B4: #VALUE! treated as missing.', 'Time column A stops increasing at sheet row 5; series ended.']);
    expect(JSON.stringify(grid)).toBe(before);
    expect(() => extractSeries(grid, { ...layout, dataRow: 0 })).toThrow('Invalid table layout.');
  });

  it('matches every Python-pinned fixture layout, channel summary and warning', async () => {
    const expected = JSON.parse(readFileSync(folder + 'expected.json', 'utf8'));
    for (const file of expected.files) {
      const bytes = new Uint8Array(readFileSync(folder + file.file));
      const units = file.file.endsWith('.xlsx') ? await workbookChannelUnits(bytes) : new Map<string, string>();
      expect(Object.fromEntries(units)).toEqual(file.channelUnits);
      if (file.file.endsWith('.xlsx')) expect(await listSheets(bytes)).toEqual(file.sheets.map((s: { sheet: string }) => s.sheet));
      for (const sheet of file.sheets) {
        const grid = sheet.sheet === null ? readDelimited(new TextDecoder().decode(bytes)) : await readSheet(bytes, sheet.sheet);
        const layout = detectShape(grid), result = extractSeries(grid, layout, units);
        close({ sheet: sheet.sheet, layout, channelUnits: Object.fromEntries(channelUnits(grid)), timeShiftHint: timeShiftHint(grid),
          channels: result.channels.map(c => ({ name: c.name, unit: c.unit, rawUnit: c.rawUnit, column: c.column, samples: c.t.length, missing: c.missing,
            first: [c.t[0], c.values[0]], last: [c.t.at(-1), c.values.at(-1)], calibrationHint: calibrationHint(c.name, c.unit) })), warnings: result.warnings }, sheet);
      }
    }
  });
});
