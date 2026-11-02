"""Build the format 1.6 plan and series expectations from unchanged part 1 files."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

from fireplan import Plan
from fireplan import tables, xlsx
from fireplan.test_data import TestDataSource, manifest_for, read_source

DEST = ROOT / 'fixtures/test-data'


def build():
    plan = Plan.new('Synthetic instrument test data')
    plan.meta.update(created='2026-01-01T00:00:00Z', modified='2026-01-01T00:00:00Z')
    plan.add(dict(id='burner', type='burner', name='Synthetic burner',
                  transform=dict(position_m=[0, 0, 0]),
                  footprint=dict(shape='square', size_m=[1, 1]), fire=dict(hrr_kw=80)))
    for oid, name, position in [('hf-east', 'HF east', [3, 0, 1.5]), ('hf-west', 'HF west', [-3, 0, 1.5])]:
        plan.add(dict(id=oid, type='heatFluxSensor', name=name,
                      transform=dict(position_m=position), gauge=dict(kind='schmidt-boelter', range_kw_m2=50)))
    plan.add(dict(id='tc-tree', type='thermocouple', name='TC low',
                  transform=dict(position_m=[0, 0, 1]), beadOffsets_m=[0, 0.5, 1, 1.5, 2]))
    raw = (DEST / 'logger-export.xlsx').read_bytes()
    shift = xlsx.workbook_time_shift_hint(raw)
    assert shift.seconds == tables.time_shift_hint(xlsx.read_sheet(raw, 'Processed')).seconds == 120
    units = xlsx.workbook_channel_units(raw)
    logger = tables.extract_series(xlsx.read_sheet(raw, 'Log'), tables.detect_shape(xlsx.read_sheet(raw, 'Log')), units)
    mappings = []
    for c, oid in zip(logger.channels[:2], ['hf-east', 'hf-west']):
        mappings.append(dict(channel=c.name, object=oid, scale=tables.calibration_hint(c.name, c.unit).scale,
                             offset=0 if oid == 'hf-east' else 0.123456789012345))
    mappings.extend(dict(channel=f'TC tree bead {i + 1}', object='tc-tree', bead=i) for i in range(5))
    sources = [dict(id='logger', name='Synthetic logger', role='measured',
                    file=dict(id='logger-file', kind='spreadsheet', path='logger-export.xlsx'),
                    table=dict(sheet='Log', shape='paired-time', headerRow=1, unitsRow=None,
                               dataRow=2, timeColumn=None, unitsSheet=None),
                    timeOffset_s=shift.seconds, channels=mappings),
               dict(id='fds', name='Synthetic FDS', role='simulated',
                    file=dict(id='fds-file', kind='spreadsheet', path='room-test_devc.csv'),
                    table=dict(sheet=None, shape='fds', headerRow=2, unitsRow=1, dataRow=3, timeColumn=0),
                    channels=[dict(channel='HF east', object='hf-east'),
                              dict(channel='TC low', object='tc-tree', bead=0)])]
    for raw_source in sources:
        source = TestDataSource(raw_source)
        path = DEST / source.file['path']
        grid, units = read_source(source, path)
        raw_source['manifest'] = manifest_for(source, grid, dict(size=path.stat().st_size, modified=None, units=units))
    plan.data['testData'] = sources
    plan.validate_schema()
    plan.save(DEST / 'test-data.ftp.json', update_modified=False)
    expected = []
    for obj in plan.objects:
        for bead in range(5) if obj.type == 'thermocouple' else [None]:
            for s in plan.series(obj, bead):
                expected.append(dict(object=obj.id, bead=bead, sourceId=s.source_id, source=s.source, role=s.role,
                                     unit=s.unit, samples=len(s.t), missing=s.missing,
                                     first=[float(s.t[0]), float(s.values[0])], last=[float(s.t[-1]), float(s.values[-1])]))
    (DEST / 'series-expected.json').write_bytes((json.dumps(expected, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(f'Wrote format 1.6 plan, {len(sources)} sources and {len(expected)} series expectations.')


if __name__ == '__main__':
    build()
