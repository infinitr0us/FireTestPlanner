"""Rebuild the linked-file demonstration from the engineer-supplied CSV."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
from fireplan import Plan
from fireplan.linked_files import parse_reconstruction_csv


def main():
    data = json.loads((ROOT / 'fixtures/pool-fire-camera-row.ftp.json').read_text(encoding='utf-8'))
    data['meta']['title'] = 'Linked test data demonstration'
    data['meta']['notes'] = ('Demonstration of external file links using the engineers\' sample files. '
                             'The MP4 is a fire simulation example, assigned to a camera to demonstrate linking; '
                             'it is not footage from this reference layout. Reconstruction measurements do not change the planned HRR.')
    plot = parse_reconstruction_csv((ROOT / 'fixtures/linked-files/volumes.csv').read_text(encoding='utf-8'),
                                    imported_at='2026-09-05T18:00:00Z')
    for obj in data['objects']:
        if obj['id'] == 'burner-main':
            obj['linkedFiles'] = [{'id': 'reconstruction', 'kind': 'spreadsheet', 'path': 'volumes.csv',
                                   'label': 'Example reconstruction',
                                   'plot': plot}]
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
