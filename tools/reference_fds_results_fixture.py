"""Print the independent cell-centred slice reference using FDSreader 1.11.7.

python tools/reference_fds_results_fixture.py local/fds-run/completed
The committed test pins this output; it is not calculated by the application reader.
FDSreader already drops the low ghost row and column in SubSlice.data.
"""
import argparse
import json
from pathlib import Path

import fdsreader


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--file', default='room_corner_1_1.sf')
    args = parser.parse_args()
    if fdsreader.__version__ != '1.11.7':
        raise RuntimeError('The reference is pinned to FDSreader 1.11.7')
    fdsreader.settings.ENABLE_CACHING = False
    sim = fdsreader.Simulation(str(args.source.resolve()))
    matches = [sub for slc in sim.slices for sub in slc.subslices if sub.filename == args.file]
    if len(matches) != 1:
        raise ValueError('Expected one subslice matching --file')
    sub = matches[0]
    if not sub.cell_centered or sub.orientation != 1:
        raise ValueError('Expected a cell-centred X plane')
    values = sub.data
    middle = len(values) // 2
    frame = values[middle]
    result = {'fdsreader': fdsreader.__version__, 'file': args.file,
              'frame': middle, 'count': len(values), 'shape': list(frame.shape),
              'time': float(sub.times[middle]), 'min': float(frame.min()), 'max': float(frame.max()),
              'corners': [float(frame[j, k]) for j, k in ((0, 0), (-1, 0), (0, -1), (-1, -1))],
              'cellCentreX': float(sub.get_coordinates()['x'][0])}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
