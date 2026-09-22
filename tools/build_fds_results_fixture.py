"""Extract three unchanged frames from two meshes of the external FDS 6.9.1 run.

Run from any directory: python tools/build_fds_results_fixture.py [source-folder]
The small fixture is versioned; rebuilding it requires the external engineer run.
No simulation values, coordinates, labels, or timestamps are synthesized.
"""
from pathlib import Path
import math
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'fixtures/fds_2'
DEST = ROOT / 'fixtures/fds-results'
FRAMES = (0, 1500, 3000)


def record(stream, expected=None):
    marker = stream.read(4)
    if len(marker) != 4:
        raise ValueError('Truncated record header')
    size = struct.unpack('<i', marker)[0]
    if size < 0 or (expected is not None and size != expected):
        raise ValueError('Unexpected record size')
    data = stream.read(size)
    if len(data) != size or stream.read(4) != marker:
        raise ValueError('Invalid record trailer')
    return data


def scalar(name):
    with (SOURCE / name).open('rb') as stream:
        for _ in range(3):
            record(stream, 30)
        if name.endswith('.sf'):
            patches = [struct.unpack('<6i', record(stream, 24))]
        else:
            count, = struct.unpack('<i', record(stream, 4))
            patches = [struct.unpack('<9i', record(stream, 36))[:6] for _ in range(count)]
        start = stream.tell()
        stride = 12 + sum(8 + 4 * math.prod(p[2*a+1] - p[2*a] + 1 for a in range(3)) for p in patches)
        if ((SOURCE / name).stat().st_size - start) != 3001 * stride:
            raise ValueError('Expected the completed 3001-frame source run')
        stream.seek(0)
        payload = stream.read(start)
        for frame in FRAMES:
            stream.seek(start + frame * stride)
            payload += stream.read(stride)
        (DEST / name).write_bytes(payload)
    (DEST / (name + '.bnd')).write_bytes((SOURCE / (name + '.bnd')).read_bytes())


def smoke(name):
    rows = (SOURCE / (name + '.sz')).read_text().splitlines()
    if rows[0].strip() != '0' or len(rows) != 3002:
        raise ValueError('Expected a 3001-frame RLE index')
    offsets = []
    offset = 40
    for row in rows[1:]:
        size = int(row.split()[2])
        offsets.append((offset, 36 + size))
        offset += 36 + size
    if offset != (SOURCE / name).stat().st_size:
        raise ValueError('Smoke index disagrees with source file')
    with (SOURCE / name).open('rb') as stream:
        payload = stream.read(40)
        for frame in FRAMES:
            offset, size = offsets[frame]
            stream.seek(offset)
            payload += stream.read(size)
        (DEST / name).write_bytes(payload)
    (DEST / (name + '.sz')).write_bytes(('0\n' + '\n'.join(rows[frame + 1] for frame in FRAMES) + '\n').encode())


def main():
    DEST.mkdir(exist_ok=True)
    names = {f'RC_BS_2_{mesh}_{suffix}' for mesh in (1, 2)
             for suffix in ('1.sf', '4.bf', '1.s3d', '2.s3d', '3.s3d')}
    lines = (SOURCE / 'RC_BS_2.smv').read_text().splitlines()
    kept = []
    i = 0
    while i < len(lines):
        tag = lines[i].strip().split(' ')[0]
        if tag in ('SLCF', 'SLCC', 'BNDF', 'BNDC', 'SMOKF3D'):
            if lines[i + 1].strip() in names:
                kept.extend(lines[i:i+5])
            i += 5
        else:
            kept.append(lines[i])
            i += 1
    (DEST / 'RC_BS_2.smv').write_bytes(('\n'.join(kept) + '\n').encode())
    for name in sorted(names):
        (smoke if name.endswith('.s3d') else scalar)(name)
    for kind in ('devc', 'hrr'):
        name = f'RC_BS_2_{kind}.csv'
        rows = (SOURCE / name).read_text().splitlines()
        # Preserve three actual CSV samples, including the independent 600 s check.
        selected = [0, min(range(len(rows)-2), key=lambda n: abs(float(rows[n+2].split(',')[0]) - 600)), len(rows)-3]
        (DEST / name).write_bytes(('\n'.join(rows[:2] + [rows[n+2] for n in selected]) + '\n').encode())
    print(f'Wrote {len(names)} fields with frames {FRAMES} to {DEST}')
    print(f'{sum(p.stat().st_size for p in DEST.iterdir() if p.is_file()):,} bytes')


if __name__ == '__main__':
    main()
