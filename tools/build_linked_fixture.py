"""Rebuild the linked-file demonstration from the engineer-supplied CSV."""
import csv
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
from fireplan import Plan


def main():
    data = json.loads((ROOT / 'fixtures/pool-fire-camera-row.ftp.json').read_text(encoding='utf-8'))
    data['meta']['title'] = 'Linked test data demonstration'
    data['meta']['notes'] = ('Demonstration of external file links using the engineers\' sample files. '
                             'The MP4 is a fire simulation example, assigned to a camera to demonstrate linking; '
                             'it is not footage from this reference layout. Reconstruction measurements do not change the planned HRR.')
    with (ROOT / 'fixtures/linked-files/volumes.csv').open(encoding='utf-8-sig', newline='') as fh:
        samples = [[float(row[key]) for key in ('timestamp_s', 'volume_m3', 'surface_area_m2')]
                   for row in csv.DictReader(fh)]
    for obj in data['objects']:
        if obj['id'] == 'burner-main':
            obj['linkedFiles'] = [{'id': 'reconstruction', 'kind': 'spreadsheet', 'path': 'volumes.csv',
                                   'label': 'Example reconstruction',
                                   'plot': {'importedAt': '2026-09-05T18:00:00Z', 'samples': samples}}]
        elif obj['id'] == 'cam-gopro':
            obj['linkedFiles'] = [{'id': 'example-video', 'kind': 'video', 'path': 'video_example.mp4',
                                   'label': 'Simulation example (demonstration only)'}]
    # Keep this assertion so changes to camera IDs cannot silently remove the video.
    assert sum(len(o.get('linkedFiles', [])) for o in data['objects']) == 2
    plan = Plan(data)
    plan.validate_schema()
    plan.save(ROOT / 'fixtures/linked-files/linked-test.ftp.json', update_modified=False)


if __name__ == '__main__':
    main()
