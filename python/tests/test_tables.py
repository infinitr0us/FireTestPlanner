"""Independent corner cases plus shared Python-written expectations for both engines."""
from dataclasses import asdict
import io
import json
import math
from pathlib import Path
import time
import zipfile

import pytest

from fireplan.xlsx import list_sheets, read_sheet, workbook_channel_units, workbook_time_shift_hint
from fireplan.tables import Grid, Layout, calibration_hint, channel_units, detect_shape, extract_series, read_delimited, time_shift_hint

FOLDER = Path(__file__).resolve().parents[2] / 'fixtures/test-data'
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

MIXED = [
    ['Time', 'ELAPSED TIME', 'Duct oxygen', 'Gauge_23.17kW/m2permV', 'Gauge_23.17kW/m2permV', 'Free_0r', 'Free_0r', 'Free_0r', None],
    ['From ignition', '[sec]', 'Volt', '[V]', '[kW/m2]', 'Duct temp', 'Air velocity', 'Duct temp', '[MJ]'],
    [None, 120, '(0.7, 20.9)', None, 'Calculated', '[ºC]', '[m/s]', '[C]', None],
    ['[mim]', 'shft time', None, 0.72, None, 'T', 'Vel', 'm', None],
    [-2, -120, 2, 0.001, 23.17, 21, 1, 22, 0],
    [-1, -60, 2.1, 0.002, 42.88, 22, 2, 23, 1],
    [0, 0, 2.2, 0.003, 64.32, 23, 3, 24, 2],
]


def test_metadata_units():
    metadata = [['Property', 'Value'], ['Source', 'Invented'], [], ['Datatype', 'cHaNnEl', 'UNIT'], ['Double', 'Gauge', 'Volts'], ['Double', 'Probe', 'ºC'], [], ['Double', 'Ignored', 'A']]
    units = channel_units(metadata)
    assert units == {'Gauge': 'Volts', 'Probe': 'ºC'}
    logger = [['Gauge_Time', 'Gauge', 'Probe_Time', 'Probe'], [0, 1, 0, 2], [1, 3, 1, 4]]
    assert [(c.unit, c.raw_unit) for c in extract_series(logger, detect_shape(logger), units).channels] == [('V', 'Volts'), ('°C', 'ºC')]
    assert extract_series([['Time', 'Gauge'], ['s', '[kW/m2]'], [0, 1]], Layout('plain', 1, 2, 3, 0), units).channels[0].unit == 'kW/m2'
    raw = workbook('<row r="3"><c r="B3" t="inlineStr"><is><t>Channel</t></is></c><c r="D3" t="inlineStr"><is><t>Unit</t></is></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>Gauge</t></is></c><c r="D4" t="inlineStr"><is><t>V</t></is></c></row>')
    assert workbook_channel_units(raw) == {'Gauge': 'V'}


def test_composed_headers():
    layout = detect_shape(MIXED)
    result = extract_series(MIXED, layout)
    assert (layout.shape, layout.data_row, layout.time_column) == ('processed', 5, 1)
    assert [(c.name, c.unit, c.raw_unit) for c in result.channels] == [
        ('Time', 'mim', '[mim]'), ('Duct oxygen', 'V', 'Volt'),
        ('Gauge_23.17kW/m2permV [V]', 'V', '[V]'), ('Gauge_23.17kW/m2permV [kW/m2]', 'kW/m2', '[kW/m2]'),
        ('Duct temp', '°C', '[ºC]'), ('Air velocity', 'm/s', '[m/s]'), ('Duct temp#2', '°C', '[C]'), ('Column I', 'MJ', '[MJ]')]
    assert all(c.t[0] == -120 and c.t[2] == 0 for c in result.channels)
    assert detect_shape([['Time', 'Elapsed', 'Value'], ['[mim]', '[sec]', '[V]'], ['note'], [-1, -60, 2], [0, 0, 3]]).time_column == 1
    grid = [['Time', 'Calculated', 'Free_0'], [0, 1, 2]]
    assert [c.name for c in extract_series(grid, detect_shape(grid)).channels] == ['Calculated', 'Free_0']


def test_shift_hints():
    assert asdict(time_shift_hint(MIXED)) == dict(seconds=120, row=3, column=1)
    assert asdict(time_shift_hint([['offset', 12], ['description', 'text']])) == dict(seconds=12, row=1, column=1)
    assert asdict(time_shift_hint([['ignition at', 'other'], [30, None]])) == dict(seconds=30, row=2, column=0)
    assert asdict(time_shift_hint([[12, 'shift', 12]])) == dict(seconds=12, row=1, column=0)
    assert time_shift_hint([[12, 'shift', 13]]) is None
    ambiguous = [row[:] for row in MIXED]
    ambiguous[3][2] = 0.72
    assert asdict(time_shift_hint(ambiguous)) == dict(seconds=120, row=3, column=1)
    assert time_shift_hint([[None, 12], ['note', 'shift', 0.72], [None, 13]]) is None
    assert asdict(time_shift_hint([[None, 12], ['note', 'shift', 0.72], [None, 12]])) == dict(seconds=12, row=1, column=1)
    assert time_shift_hint([['Time', 'offset'], [0, 10], [1, 20]]) is None
    assert time_shift_hint([['Time', 'Value'], [0, 1]]) is None


def test_workbook_shift_hints():
    raw = (FOLDER / 'logger-export.xlsx').read_bytes()
    assert asdict(workbook_time_shift_hint(raw)) == dict(seconds=120, sheets=['Processed'])
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries = {name: z.read(name) for name in z.namelist()}
    def rezip():
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for name, value in entries.items():
                z.writestr(name, value)
        return out.getvalue()

    # An `offset` on a sheet that is not a processed table (a logger's metadata sheet
    # has an offset column) is not a shift and must not make the agreed hint ambiguous.
    entries['xl/worksheets/constants.xml'] = (f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>offset</t></is></c><c r="B1"><v>121</v></c></row></sheetData></worksheet>').encode('utf-8')
    assert asdict(workbook_time_shift_hint(rezip())) == dict(seconds=120, sheets=['Processed'])
    # Two processed sheets that disagree do make it ambiguous.
    rows = [['Time', 'ELAPSED TIME', 'Value'], ['From ignition', '[sec]', '[kW]'], [None, 121, None],
            ['[min]', 'shft time', None], [0, 0, 1], [1 / 60, 1, 2], [2 / 60, 2, 3]]

    def cell(ref, v):
        return (f'<c r="{ref}"><v>{v!r}</v></c>' if isinstance(v, (int, float))
                else f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>')
    body = ''.join(f'<row r="{i + 1}">' + ''.join(cell(f'{"ABC"[j]}{i + 1}', v) for j, v in enumerate(r) if v is not None)
                   + '</row>' for i, r in enumerate(rows))
    entries['xl/worksheets/constants.xml'] = f'<worksheet xmlns="{NS}"><sheetData>{body}</sheetData></worksheet>'.encode('utf-8')
    assert workbook_time_shift_hint(rezip()) is None
    assert workbook_time_shift_hint(workbook('')) is None


def test_unit_gated_calibration_and_empty_sheets():
    name = 'Gauge_23.17kW/m2permV'
    for unit in ['V', 'Volt', 'Volts', '[V]', None]:
        assert asdict(calibration_hint(name, unit)) == dict(scale=23170, unit='kW/m2', input_unit='V')
    assert asdict(calibration_hint(name, 'mV')) == dict(scale=23.17, unit='kW/m2', input_unit='mV')
    for unit in ['kW/m2', '[kW/m²]', 'C', 'A', 'mim']:
        assert calibration_hint(name, unit) is None
    for grid in [[], [['Constants', 'Name', 'Value'], ['gain', 'Made up', 3]], [['Time', 'X', 'Y'], [0, None, None]]]:
        assert asdict(extract_series(grid, detect_shape(grid))) == dict(channels=[], warnings=['No time series on this sheet.'])


def test_raw_units_and_unit_label_collisions():
    grid = [
        ['Time', 'Gauge', 'Gauge', None, 'Gauge [V]', 'Free_0', 'Free_0', 'Free_0'],
        ['[sec]', '[V]', 'Volts', '[kW/m2]', '[V]', 'mass', 'gas', 'power'],
        [None, '  V  ', 'V', 'Gauge', 'V', '[kg/s]', '[%Vol]', 'kW/m²'],
        [0, 1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7, 8],
    ]
    channels = extract_series(grid, detect_shape(grid)).channels
    assert [c.name for c in channels] == ['Gauge [V]#2', 'Gauge [V]#3', 'Gauge [kW/m2]', 'Gauge [V]', 'mass', 'gas', 'power']
    assert [c.unit for c in channels] == ['V', 'V', 'kW/m2', 'V', 'kg/s', '%Vol', 'kW/m²']
    raw = extract_series([['Time', 'Probe'], ['s', '  Volts  '], [0, 1]], Layout('plain', 1, 2, 3, 0)).channels[0]
    assert (raw.unit, raw.raw_unit) == ('V', '  Volts  ')
    assert channel_units([['Channel', 'Unit'], ['a', 'V'], [], ['channel', 'unit'], ['a', 'mV'], ['b', 'A'], []]) == {'a': 'mV', 'b': 'A'}


def test_workbook_units_reuse_shared_parts(monkeypatch):
    opened, original = [], zipfile.ZipFile.open

    def tracked(self, name, *args, **kwargs):
        opened.append(name)
        return original(self, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, 'open', tracked)
    units = workbook_channel_units((FOLDER / 'logger-export.xlsx').read_bytes())
    assert units['O2 analyser'] == 'Volts'  # Later metadata sheet wins.
    assert len(units) == 13
    assert opened.count('xl/workbook.xml') == 1
    assert opened.count('xl/_rels/workbook.xml.rels') == 1
    assert opened.count('xl/sharedStrings.xml') == 1
    assert len([name for name in opened if name.startswith('xl/worksheets/')]) == 6


def workbook(xml, shared=None, extra=None):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Log &amp; more" sheetId="7" r:id="r7"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r7" Target="/xl/worksheets/custom.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>')
        z.writestr('xl/worksheets/custom.xml', f'<worksheet xmlns="{NS}"><sheetData>{xml}</sheetData></worksheet>')
        if shared is not None:
            z.writestr('xl/sharedStrings.xml', f'<sst xmlns="{NS}">{shared}</sst>')
        for name, value in (extra or {}).items():
            z.writestr(name, value)
    return out.getvalue()


def test_xml_corner_cases():
    raw = workbook('<row r="12"><c r="AB12"><v> 5.0010080E+000</v></c><c r="A12" t="s"><v>0</v></c><c r="C12" t="inlineStr"><is><t xml:space="preserve"> x &lt; &#x3b1; &quot; &#39; </t></is></c><c r="D12" t="str"><f>ignored()</f><v>A&amp;B</v></c><c r="E12" t="b"><v>1</v></c><c r="F12" t="b"><v>0</v></c><c r="G12"><f>1+1</f><v>2</v></c><c r="H12"><f>1+1</f></c></row><row r="2"><c r="B2"><v>-2e-3</v></c></row>', '<si><r><t xml:space="preserve"> rich </t></r><r><t>&amp; text</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>')
    assert list_sheets(raw) == ['Log & more']
    grid = read_sheet(raw, 'Log & more')
    assert len(grid) == 12 and all(len(row) == 28 for row in grid)
    assert grid[0] == [None] * 28 and grid[1][1] == -0.002
    assert grid[11][:8] == [' rich & text', None, ' x < α " \' ', 'A&B', 1, 0, 2, None]
    assert grid[11][27] == 5.001008


def test_errors_without_shared_strings():
    codes = ['#NUM!', '#DIV/0!', '#N/A', '#VALUE!']
    grid = read_sheet(workbook('<row r="1">' + ''.join(f'<c r="{chr(65+i)}1" t="e"><v>{s}</v></c>' for i, s in enumerate(codes)) + '</row>'), 'Log & more')
    assert grid == [[None] * 4]
    assert grid.errors == [dict(row=1, column=i, code=s) for i, s in enumerate(codes)]
    with pytest.raises(ValueError, match='Sheet "missing" was not found.'):
        read_sheet(workbook(''), 'missing')


def test_only_requested_parts_opened(monkeypatch):
    opened, original = [], zipfile.ZipFile.open

    def tracked(self, name, *args, **kwargs):
        opened.append(name)
        return original(self, name, *args, **kwargs)

    raw = workbook('<row><c r="A1"><v>42</v></c></row>', extra={'xl/unused.xml': 'unread', 'xl/vbaProject.bin': 'unread'})
    monkeypatch.setattr(zipfile.ZipFile, 'open', tracked)
    assert list_sheets(raw) == ['Log & more']
    assert read_sheet(raw, 'Log & more') == [[42]]
    assert set(opened) == {'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/custom.xml'}


def test_format_refusal():
    ods = io.BytesIO()
    with zipfile.ZipFile(ods, 'w') as z:
        z.writestr('mimetype', 'application/vnd.oasis.opendocument.spreadsheet')
    for raw, fmt in [(bytes.fromhex('d0cf11e0'), '.xls'), (ods.getvalue(), '.ods')]:
        for reader in [list_sheets, lambda b: read_sheet(b, 'Log')]:
            with pytest.raises(ValueError) as error:
                reader(raw)
            assert str(error.value) == f'{fmt} is not supported; save as .xlsx or .csv.'


def test_prefixed_xml_and_relative_parts():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml', '<x:workbook xmlns:x="urn:sheet" xmlns:r="urn:rel"><x:sheets><x:sheet name="A &gt; B" r:id="second"/></x:sheets></x:workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<r:Relationships xmlns:r="urn:rel"><r:Relationship Id="second" Target="worksheets/../worksheets/custom%20name.xml"/></r:Relationships>')
        z.writestr('xl/worksheets/custom name.xml', '<x:worksheet xmlns:x="urn:sheet"><!-- ignored <row> --><x:sheetData><x:row r="1"><x:c r="B1" t="inlineStr"><x:is><x:r><x:t xml:space="preserve"><![CDATA[ a > b & c ]]></x:t></x:r><x:r><x:t> tail</x:t></x:r></x:is></x:c><x:c r="A1" t="str"><x:v>&amp;lt;</x:v></x:c><x:c r="C1"/></x:row><x:row r="3"/></x:sheetData></x:worksheet>')
    assert list_sheets(out.getvalue()) == ['A > B']
    assert read_sheet(out.getvalue(), 'A > B') == [['&lt;', ' a > b & c  tail', None], [None] * 3, [None] * 3]


def test_invalid_bounds_and_shared_index():
    with pytest.raises(ValueError, match='dense grid limit'):
        read_sheet(workbook('<row r="1"><c r="XFD1048576"><v>1</v></c></row>'), 'Log & more')
    with pytest.raises(ValueError, match='Invalid shared string index.'):
        read_sheet(workbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'), 'Log & more')


def test_performance():
    def column(n):
        s = ''
        n += 1
        while n:
            n, rem = divmod(n - 1, 26)
            s = chr(65 + rem) + s
        return s
    xml = ''.join(f'<row r="{i+1}">' + ''.join(f'<c r="{column(j)}{i+1}"><v>{i*60+j}</v></c>' for j in range(60)) + '</row>' for i in range(5000))
    raw = workbook(xml)
    start = time.perf_counter()
    grid = read_sheet(raw, 'Log & more')
    elapsed = time.perf_counter() - start
    assert len(grid) == 5000 and grid[-1][-1] == 299999
    assert elapsed < 15
    print(f'OOXML 5000 x 60: {elapsed:.3f} s')


def test_delimiters():
    assert read_delimited('\ufeff"Time";"a,b";"say ""hi"""\r\n 5.0010080E+000;2;\r\n\r\n6;"x;y";"line\nnext"') == [
        ['Time', 'a,b', 'say "hi"'], [5.001008, 2, None], [None] * 3, [6, 'x;y', 'line\nnext']]
    assert read_delimited('t\tx\n0\t1\n1') == [['t', 'x'], [0, 1], [1, None]]
    assert read_delimited('t,x\n0,0x10\n1,Infinity') == [['t', 'x'], [0, '0x10'], [1, 'Infinity']]
    with pytest.raises(ValueError, match='unclosed'):
        read_delimited('a,b\n"unclosed')
    with pytest.raises(ValueError, match='Malformed'):
        read_delimited('a,b\n"x"z,2')


def test_shapes():
    assert asdict(detect_shape([['a_Time*', 'a', 'b_Time', 'b'], [0, 1, 0, 2]])) == dict(shape='paired-time', header_row=1, units_row=None, data_row=2, time_column=None)
    assert asdict(detect_shape([['s', 'kW'], ['Time', 'HRR'], [0, 1]])) == dict(shape='fds', header_row=2, units_row=1, data_row=3, time_column=0)
    grid = [['group', 'Free_0', 'Free_0'], ['Time [min]', 'Time [sec]', 'HF'], ['[min]', '[s]', '[kW/m2]'], ['[min] | shift'], [-1, -60, 0], [0, 0, 1], [0, 0, 2]]
    assert asdict(detect_shape(grid)) == dict(shape='processed', header_row=2, units_row=3, data_row=5, time_column=1)
    assert asdict(detect_shape([['index', 'Time', 'a'], [0, -1, 1], [1, 0, 2]])) == dict(shape='plain', header_row=1, units_row=None, data_row=2, time_column=1)
    assert asdict(detect_shape([])) == dict(shape='plain', header_row=1, units_row=None, data_row=2, time_column=0)


def test_missing_duplicates_and_end():
    grid = [['Time', 'A', 'A', 'Empty'], [0, 10, None, None], [1, None, 20, None], [None, 99, 99, None], [2, 12, 22, None], [2, 40, 50, None], [3, 41, 51, None]]
    result = extract_series(grid, detect_shape(grid))
    assert [asdict(c) for c in result.channels] == [
        dict(name='A', unit=None, raw_unit=None, column=1, t=[0, 2], values=[10, 12], missing=2),
        dict(name='A#2', unit=None, raw_unit=None, column=2, t=[1, 2], values=[20, 22], missing=2)]
    assert result.warnings == ['Time column A stops increasing at sheet row 6; series ended.', 'Duplicate channel name "A" renamed to "A#2".', 'Channel "Empty" has no numeric samples and was dropped.']
    paired = [['a_Time', 'a', 'b_Time*', 'b'], [0, 1, 10, 3], [0, 2, 11, 4], [1, 3, 12, 5]]
    own = extract_series(paired, detect_shape(paired))
    assert [c.t for c in own.channels] == [[0], [10, 11, 12]]
    assert own.warnings == ['Time column A stops increasing at sheet row 3; series ended.']
    grid = [['Time', 'A'], [0, None], [0, 2]]
    assert extract_series(grid, Layout('plain', 1, None, 2, 0)).channels == []


def test_calibration():
    for name in ['HF_23.17kW/m2permV', '23.17 kW/m2 per mV']:
        assert asdict(calibration_hint(name, None)) == dict(scale=23170, unit='kW/m2', input_unit='V')
    assert calibration_hint('TC 23.17 C', None) is None
    assert calibration_hint('HF_-23.17kW/m2permV', None) is None
    assert asdict(calibration_hint('HF_23.17kW/m2permV_extra', None)) == dict(scale=23170, unit='kW/m2', input_unit='V')
    assert calibration_hint('HF_23.17\u0085kW/m2permV', None) is None


def test_override_units_and_suffix_collisions():
    grid = [['Time minutes', 'Time alternate', 'q', 'q', 'q#2'], ['min', 'seconds', 'kW', 'kW', 'kW'], [0, 0, 1, 2, 3], [1, 60, 4, 5, 6]]
    layout = detect_shape(grid)
    assert layout == Layout('plain', 1, 2, 3, 1)
    result = extract_series(grid, Layout('plain', 1, 2, 3, 0))
    assert [c.name for c in result.channels] == ['Time alternate', 'q', 'q#3', 'q#2']
    assert all(c.t[1] == 1 for c in result.channels)
    assert result.channels[0].unit == 'seconds'
    assert result.warnings == ['Duplicate channel name "q" renamed to "q#3".']
    assert detect_shape([['a', 'b_Time', 'b', 'noise', 'more', 'extra'], [0, 0, 1, 2, 3, 4]]).shape == 'plain'


def test_error_warnings_purity_and_missing_time():
    grid = Grid([['Time', 'Value'], [0, 1], [None, 2], [2, None], [1, 4]], [dict(row=3, column=0, code='#N/A'), dict(row=4, column=1, code='#VALUE!')])
    before = json.dumps(grid)
    layout = detect_shape(grid)
    result = extract_series(grid, layout)
    assert asdict(result.channels[0]) == dict(name='Value', unit=None, raw_unit=None, column=1, t=[0], values=[1], missing=2)
    assert result.warnings == ['Cell A3: #N/A treated as missing.', 'Cell B4: #VALUE! treated as missing.', 'Time column A stops increasing at sheet row 5; series ended.']
    assert json.dumps(grid) == before
    with pytest.raises(ValueError, match='Invalid table layout.'):
        extract_series(grid, Layout('plain', 1, None, 0, 0))


def assert_close(actual, expected):
    if isinstance(expected, (float, int)):
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=0)
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a, e in zip(actual, expected):
            assert_close(a, e)
    elif isinstance(expected, dict):
        assert actual.keys() == expected.keys()
        for k in expected:
            assert_close(actual[k], expected[k])
    else:
        assert actual == expected


def test_shared_expectations():
    expected = json.loads((FOLDER / 'expected.json').read_text(encoding='utf-8'))
    for file in expected['files']:
        raw = (FOLDER / file['file']).read_bytes()
        units = workbook_channel_units(raw) if file['file'].endswith('.xlsx') else {}
        assert units == file['channelUnits']
        if file['file'].endswith('.xlsx'):
            assert list_sheets(raw) == [s['sheet'] for s in file['sheets']]
        for sheet in file['sheets']:
            grid = read_sheet(raw, sheet['sheet']) if sheet['sheet'] is not None else read_delimited(raw.decode('utf-8'))
            layout = detect_shape(grid)
            result = extract_series(grid, layout, units)
            shift = time_shift_hint(grid)
            channels = []
            for c in result.channels:
                hint = calibration_hint(c.name, c.unit)
                channels.append(dict(name=c.name, unit=c.unit, rawUnit=c.raw_unit, column=c.column, samples=len(c.t), missing=c.missing,
                                     first=[c.t[0], c.values[0]], last=[c.t[-1], c.values[-1]],
                                     calibrationHint=None if hint is None else dict(scale=hint.scale, unit=hint.unit, inputUnit=hint.input_unit)))
            summary = dict(sheet=sheet['sheet'], layout=dict(shape=layout.shape, headerRow=layout.header_row, unitsRow=layout.units_row, dataRow=layout.data_row, timeColumn=layout.time_column),
                           channelUnits=channel_units(grid), timeShiftHint=asdict(shift) if shift else None, channels=channels, warnings=result.warnings)
            assert_close(summary, sheet)
