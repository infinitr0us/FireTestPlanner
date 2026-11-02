"""Build small, entirely synthetic measured tables and Python-pinned summaries.

SpreadsheetML is handwritten with the stdlib. No real measurements or Excel
library are used. Run from any cwd; ZIP timestamps and output bytes are fixed.
"""
import importlib
from dataclasses import asdict
import io
import json
import math
from pathlib import Path
import sys
import types
from xml.sax.saxutils import escape, quoteattr
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'fixtures/test-data'
# Load only the stdlib reader modules, without fireplan.__init__ importing the
# plan/geometry stack (numpy/jsonschema). The builder also works under python -S.
package = types.ModuleType('_fixture_fireplan')
package.__path__ = [str(ROOT / 'python/fireplan')]
sys.modules[package.__name__] = package
tables = importlib.import_module('_fixture_fireplan.tables')
xlsx = importlib.import_module('_fixture_fireplan.xlsx')

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
SHIFT = 120
# All names and values are invented; no instrument serial numbers are used.
LOGGER_NAMES = ['HF east_23.17kW/m2permV', 'HF west_22.10kW/m2permV', 'HF north_19.75kW/m2permV']
LOGGER_NAMES += [f'TC tree bead {i + 1}' for i in range(5)]
LOGGER_NAMES += ['TC duct lower', 'TC duct upper', 'O2 analyser', 'CO2 analyser', 'Pressure']
LOGGER_UNITS = ['V'] * 3 + ['°C'] * 7 + ['V', 'V', 'mA']


class Error:
    def __init__(self, code):
        self.code = code


class Formula:
    def __init__(self, formula, value):
        self.formula, self.value = formula, value


def fire(t):
    """Dimensionless growth, plateau and decay, with mild deterministic variation."""
    growth = max(0, min(1, (t - 120) / 150)) ** 2
    decay = max(0, min(1, (600 - t) / 180))
    return growth * decay * (1 + 0.025 * math.sin(t / 17))


def logger_rows():
    # The brief's enumerated instruments total 13 (despite saying 12); retain all.
    rows = [[v for i, name in enumerate(LOGGER_NAMES) for v in [name + ('_Time*' if i == 1 else '_Time'), name]]]
    for t in range(600):
        f = fire(t)
        values = [18 * f / 23170, 14 * f / 22100, 11 * f / 19750]
        values += [21 + (480 - i * 45) * f + 0.2 * math.sin(t / 11 + i) for i in range(5)]
        values += [21 + 140 * f, 21 + 95 * f, 2.09 - 0.22 * f, 0.04 + 0.15 * f, 4 + 7 * f]
        if t in (173, 174):
            values[0] = None
        rows.append([v for value in values for v in [t, value]])
    return rows


def metadata_rows(log):
    rows = [['Property', 'Value'], ['Origin', 'Invented fixture, not a recorded test'], [],
            ['Group', 'Description'], ['Synthetic instruments', '600 samples at 1 Hz'], [],
            ['Channel', 'Datatype', 'Unit', 'Length', 'Minimum', 'Maximum']]
    for c, (name, unit) in enumerate(zip(LOGGER_NAMES, LOGGER_UNITS)):
        values = [row[c * 2 + 1] for row in log[1:] if row[c * 2 + 1] is not None]
        rows.append([name, 'Double', unit, 600, min(values), max(values)])
    return rows + [[], ['Not a channel table', 'V']]


def processed_rows():
    rows = [
        ['Time', 'ELAPSED TIME', 'Duct oxygen', 'Duct pressure', LOGGER_NAMES[0], LOGGER_NAMES[0],
         'Free_0', 'Free_0', 'Free_0', 'Free_0r', 'Free_0r', 'Free_0r', None, LOGGER_NAMES[1]],
        ['From ignition', '[sec]', 'Volt', 'A', '[V]', '[kW/m2]', 'Duct temp', 'Air velocity',
         'Duct temp', 'Empty channel', 'Heat released', 'Gas volume', '[kg/s]', '[mV]'],
        [None, SHIFT, '(0.7, 20.9)', None, None, 'Calculated', '[ºC]', '[m/s]', '[C]', '[V]', '[MJ]', '[m^3/s]'],
        ['[mim]', 'shft time', None, 0.72, None, None, 'T', 'Vel', 'm'],
    ]
    for t in range(600):
        f = fire(t)
        rows.append([Formula(f'B{t+5}/60', (t - SHIFT) / 60), t - SHIFT, 2.09 - 0.22 * f, 0.004 + 0.007 * f,
                     Formula(f'Log!B{t+2}', 18 * f / 23170),
                     Error('#NUM!') if t in (18, 19, 275) else Formula(f'E{t+5}*23170', 18 * f),
                     21 + 480 * f, 1 + 2 * f, None if t == 300 else 21 + 435 * f,
                     None, t * 0.01, 0.4 + 0.3 * f, 0.5 + 0.4 * f, 14 * f / 22.10])
    # Filled formulas below data: the first repeated/reset time terminates all series.
    rows += [[0] * 14, [1 / 60, 1] + [0] * 12]
    return rows


def make_workbook():
    shared, indices = [], {}

    def string_index(value):
        if value not in indices:
            indices[value] = len(shared)
            shared.append('<si><t xml:space="preserve">' + escape(value) + '</t></si>')
        return indices[value]

    def cell(ref, value):
        formula = ''
        if isinstance(value, Formula):
            formula, value = '<f>' + escape(value.formula) + '</f>', value.value
        if value is None:
            return ''
        if isinstance(value, Error):
            return f'<c r="{ref}" t="e">{formula}<v>{escape(value.code)}</v></c>'
        if isinstance(value, str):
            return f'<c r="{ref}" t="s"><v>{string_index(value)}</v></c>'
        return f'<c r="{ref}">{formula}<v>{format(value, ".12g")}</v></c>'

    def sheet(rows):
        return f'<worksheet xmlns="{NS}"><sheetData>' + ''.join(
            f'<row r="{r}">' + ''.join(cell(tables.column_name(c) + str(r), v) for c, v in enumerate(row)) + '</row>'
            for r, row in enumerate(rows, 1)) + '</sheetData></worksheet>'

    # Deliberately nonnumeric part names and unrelated sheetIds/relationship order.
    sheets = [('Metadata', 'metadata'), ('Log', 'logger'), ('Processed', 'shifted'), ('Strings', 'text'),
              ('Supplement', 'supplement'), ('Constants', 'constants')]
    log = logger_rows()
    parts = {
        'xl/worksheets/metadata.xml': sheet(metadata_rows(log)),
        'xl/worksheets/logger.xml': sheet(log),
        'xl/worksheets/shifted.xml': sheet(processed_rows()),
        'xl/worksheets/supplement.xml': sheet([['Invented metadata supplement'], [], ['Unit', 'Channel'], ['Volts', 'O2 analyser']]),
        'xl/worksheets/constants.xml': sheet([['shift', SHIFT, 'offset', SHIFT + 60], ['Constants only', 'Invented examples']]),
    }
    rich_index = len(shared)
    shared.append('<si><r><t xml:space="preserve"> rich </t></r><r><t>&amp; text</t></r></si>')
    parts['xl/worksheets/text.xml'] = f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" t="s"><v>{rich_index}</v></c><c r="B1" t="inlineStr"><is><t xml:space="preserve"> inline &lt; °C </t></is></c></row></sheetData></worksheet>'
    parts['xl/sharedStrings.xml'] = f'<sst xmlns="{NS}" uniqueCount="{len(shared)}">' + ''.join(shared) + '</sst>'
    parts['xl/workbook.xml'] = f'<workbook xmlns="{NS}" xmlns:r="{REL}"><sheets>' + ''.join(f'<sheet name={quoteattr(name)} sheetId="{i+7}" r:id="r{i+10}"/>' for i, (name, _) in enumerate(sheets)) + '</sheets></workbook>'
    parts['xl/_rels/workbook.xml.rels'] = f'<Relationships xmlns="{PKG}">' + ''.join(f'<Relationship Id="r{i+10}" Type="{REL}/worksheet" Target="worksheets/{part}.xml"/>' for i, (_, part) in reversed(list(enumerate(sheets)))) + f'<Relationship Id="strings" Type="{REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>'
    parts['_rels/.rels'] = f'<Relationships xmlns="{PKG}"><Relationship Id="workbook" Type="{REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    parts['[Content_Types].xml'] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' + ''.join(f'<Override PartName="/xl/worksheets/{part}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for _, part in sheets) + '</Types>'
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value.encode('utf-8'))
    return out.getvalue()


def summary(grid, sheet_name, units):
    layout = tables.detect_shape(grid)
    result = tables.extract_series(grid, layout, units)
    shift = tables.time_shift_hint(grid)
    channels = []
    for c in result.channels:
        hint = tables.calibration_hint(c.name, c.unit)
        channels.append(dict(name=c.name, unit=c.unit, rawUnit=c.raw_unit, column=c.column, samples=len(c.t), missing=c.missing,
                             first=[c.t[0], c.values[0]], last=[c.t[-1], c.values[-1]],
                             calibrationHint=None if hint is None else dict(scale=hint.scale, unit=hint.unit, inputUnit=hint.input_unit)))
    return dict(sheet=sheet_name, layout=dict(shape=layout.shape, headerRow=layout.header_row, unitsRow=layout.units_row, dataRow=layout.data_row, timeColumn=layout.time_column),
                channelUnits=tables.channel_units(grid), timeShiftHint=asdict(shift) if shift else None, channels=channels, warnings=result.warnings)


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    raw = make_workbook()
    assert len(raw) < 500_000
    (DEST / 'logger-export.xlsx').write_bytes(raw)
    csv = ['s,kW/m2,C,C,V,Pa', 'Time,HF east,TC low,TC high,O2,Pressure']
    for t in range(61):
        f = fire(t * 10)
        csv.append(','.join(f' {v:.7E}' for v in [t * 10, 18 * f, 21 + 480 * f, 21 + 390 * f, 2.09 - 0.22 * f, 12 * f]))
    (DEST / 'room-test_devc.csv').write_bytes(('\n'.join(csv) + '\n').encode('utf-8'))
    (DEST / 'plain.csv').write_bytes(('\ufeffTime;"Temperature; east";Heat flux\n-1;21;0\n0;21.5;\n1;22;0.25\n2;23;0.5\n').encode('utf-8'))
    expected = {'note': 'Synthetic data only. Written by tools/build_test_data_fixture.py using the Python reader; both engines assert these layouts, summaries and warnings.', 'files': []}
    units = xlsx.workbook_channel_units(raw)
    expected['files'].append(dict(file='logger-export.xlsx', channelUnits=units, sheets=[summary(xlsx.read_sheet(raw, name), name, units) for name in xlsx.list_sheets(raw)]))
    for filename in ['room-test_devc.csv', 'plain.csv']:
        expected['files'].append(dict(file=filename, channelUnits={}, sheets=[summary(tables.read_delimited((DEST / filename).read_text(encoding='utf-8')), None, {})]))
    (DEST / 'expected.json').write_bytes((json.dumps(expected, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(f'Wrote synthetic workbook ({len(raw):,} bytes), CSVs and expected.json to {DEST}')


if __name__ == '__main__':
    main()
