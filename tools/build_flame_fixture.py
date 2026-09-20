"""Rebuild the reconstructed-flame demonstration from the pipeline's own output.

The reference layout, its burner linked to the run's `volumes.csv`, and a
`reconstructedFlame` linking the run's `voxels/` folder with the manifest the
Python reader computes. `web/src/core/flame.test.ts` and `python/tests/test_flame.py`
hold both engines to this file byte for byte.
"""
import gzip
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
from fireplan import Plan
from fireplan.flame import FlameSequence
from fireplan.linked_files import parse_reconstruction_csv

IMPORTED_AT = '2026-09-19T20:00:00Z'


def main():
    data = json.loads((ROOT / 'fixtures/pool-fire-camera-row.ftp.json').read_text(encoding='utf-8'))
    data['meta']['title'] = 'Reconstructed flame demonstration'
    data['meta']['notes'] = ('The reference layout with the flame reconstructed from a test on this site: '
                             '80 visual-hull frames at 5 s in voxels/, and the same run\'s volumes.csv on the burner. '
                             'Recorded data; it changes no planned HRR, prediction or verdict.')
    plot = parse_reconstruction_csv((ROOT / 'fixtures/flame/volumes.csv').read_text(encoding='utf-8'),
                                    imported_at=IMPORTED_AT)
    for obj in data['objects']:
        if obj['id'] == 'burner-main':
            obj['linkedFiles'] = [{'id': 'volumes', 'kind': 'spreadsheet', 'path': 'volumes.csv',
                                   'label': 'Visual hull volumes', 'plot': plot}]
    plan = Plan(data)
    plan.add_reconstructed_flame('voxels', str(ROOT / 'fixtures/flame/voxels'),
                                 object_id='flame-main', name='Visual hull', burner_id='burner-main',
                                 label='Visual hull frames', imported_at=IMPORTED_AT)
    plan.validate_schema()
    assert not [i for i in plan.check() if i.code.startswith('flame-')], plan.check()
    plan.save(ROOT / 'fixtures/flame/flame-test.ftp.json', update_modified=False)
    # The packed frames, gzipped: what the bundled Example and a shared page carry.
    # gzip is the transport; the packed stream inside is the canonical, engine-
    # identical form the tests pin.
    packed = FlameSequence.load(str(ROOT / 'fixtures/flame/voxels')).pack()
    (ROOT / 'fixtures/flame/flame-test.fvs').write_bytes(gzip.compress(packed, mtime=0))


if __name__ == '__main__':
    main()
