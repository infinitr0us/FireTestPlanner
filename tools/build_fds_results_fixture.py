"""Extract unchanged first/middle/last records from a completed public FDS run.

Default: python tools/build_fds_results_fixture.py local/fds-run/completed
Use --help for another source, CHID, mesh/file selection, or frame indices.
Only metadata inventories and smoke indices are filtered; retained binary
headers/frames are byte-identical. Text retains its source spelling and padding,
with CRLF converted to LF as required by the repository.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import struct

ROOT = Path(__file__).resolve().parents[1]
FIELD_TAGS = {'SLCF': 'slice', 'SLCC': 'slice', 'BNDF': 'boundary',
              'BNDC': 'boundary', 'SMOKF3D': 'smoke'}
# Inventory-derived recipe for room_corner: burner temperature in the room,
# temperature and all three velocities at the doorway in the exterior, wall
# temperature on both meshes, room total flux, and all three smoke quantities.
# --files replaces this recipe for another case; --chid supplies its prefix.
DEFAULT_FIELDS = ('1_1.sf', '2_5.sf', '2_6.sf', '2_7.sf', '2_8.sf',
                  '1_1.bf', '2_1.bf', '1_2.bf',
                  '1_1.s3d', '1_2.s3d', '1_3.s3d',
                  '2_1.s3d', '2_2.s3d', '2_3.s3d')


def record(stream, expected=None):
    marker = stream.read(4)
    if len(marker) != 4:
        raise ValueError('Truncated record header')
    size, = struct.unpack('<i', marker)
    if size < 0 or (expected is not None and size != expected):
        raise ValueError('Unexpected record size')
    data = stream.read(size)
    if len(data) != size or stream.read(4) != marker:
        raise ValueError('Invalid record trailer')
    return data


def selected_frames(count, requested=None):
    frames = list(requested) if requested is not None else [0, count // 2, count - 1]
    if len(frames) != 3 or frames != sorted(set(frames)) or frames[0] < 0 or frames[-1] >= count:
        raise ValueError(f'Need three distinct increasing frames in a {count}-frame file')
    return frames


def scalar_layout(path):
    with path.open('rb') as stream:
        for _ in range(3):
            record(stream, 30)
        if path.suffix == '.sf':
            patches = [struct.unpack('<6i', record(stream, 24))]
        else:
            count, = struct.unpack('<i', record(stream, 4))
            if count < 0:
                raise ValueError('Negative boundary patch count')
            patches = [struct.unpack('<9i', record(stream, 36))[:6] for _ in range(count)]
        sizes = [4 * math.prod(p[2*a+1] - p[2*a] + 1 for a in range(3)) for p in patches]
        if any(size <= 0 for size in sizes):
            raise ValueError('Invalid scalar patch extent')
        start = stream.tell()
        stride = 12 + sum(8 + size for size in sizes)
    count, remainder = divmod(path.stat().st_size - start, stride)
    if remainder:
        raise ValueError(f'{path.name}: incomplete scalar frame')
    return start, [(start + n * stride, stride) for n in range(count)], sizes


def smoke_layout(path):
    rows = path.with_name(path.name + '.sz').read_bytes().splitlines(keepends=True)
    if not rows or rows[0].strip() != b'0':
        raise ValueError('Expected an RLE smoke index')
    with path.open('rb') as stream:
        record(stream, 32)
        start = stream.tell()
    offsets, offset = [], start
    for row in rows[1:]:
        parts = row.split()
        if len(parts) not in (3, 4) or int(parts[2]) < 0:
            raise ValueError('Invalid smoke index row')
        size = 36 + int(parts[2])
        offsets.append((offset, size))
        offset += size
    if offset != path.stat().st_size:
        raise ValueError(f'{path.name}: smoke index disagrees with source file')
    return start, offsets, rows


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def extract_field(source, field, requested):
    path = source / field['file']
    smoke = field['kind'] == 'smoke'
    start, offsets, layout = (smoke_layout if smoke else scalar_layout)(path)
    frames = selected_frames(len(offsets), requested)
    with path.open('rb') as stream:
        header = stream.read(start)
        payload = bytearray(header)
        samples = []
        for index in frames:
            offset, size = offsets[index]
            stream.seek(offset)
            time, = struct.unpack('<f', record(stream, 4))
            if smoke:
                unpacked, packed = struct.unpack('<2i', record(stream, 8))
                if unpacked != int(layout[index + 1].split()[1]) or packed != size - 36:
                    raise ValueError('Smoke frame sizes disagree with index')
                record(stream, packed)
            else:
                for patch_size in layout:
                    record(stream, patch_size)
            if stream.tell() != offset + size:
                raise ValueError('Frame extent mismatch')
            if not math.isfinite(time) or (samples and time <= samples[-1]['time']):
                raise ValueError('Nonmonotonic frame times')
            stream.seek(offset)
            raw = stream.read(size)
            payload.extend(raw)
            samples.append({'index': index, 'time': time, 'offset': offset,
                            'bytes': size, 'sha256': sha256(raw)})
    outputs = {path.name: bytes(payload)}
    if smoke:
        outputs[path.name + '.sz'] = layout[0] + b''.join(layout[n + 1] for n in frames)
    else:
        outputs[path.name + '.bnd'] = path.with_name(path.name + '.bnd').read_bytes()
    return outputs, {**field, 'sourceFrames': len(offsets), 'headerBytes': start,
                     'headerSha256': sha256(header), 'samples': samples}


def inventory(lines):
    fields = []
    for i, line in enumerate(lines):
        parts = line.split()
        if parts and parts[0] in FIELD_TAGS:
            fields.append({'file': lines[i+1].strip(), 'kind': FIELD_TAGS[parts[0]],
                           'mesh': int(parts[1]), 'quantity': lines[i+2].strip(),
                           'unit': lines[i+4].strip()})
    if not fields or len({f['file'] for f in fields}) != len(fields):
        raise ValueError('Missing or duplicate field filenames')
    for field in fields:
        if Path(field['file']).name != field['file'] or ':' in field['file'] or '\\' in field['file']:
            raise ValueError('Expected a flat, relative output filename')
    return fields


def counts(fields):
    return {kind: sum(f['kind'] == kind for f in fields) for kind in ('slice', 'boundary', 'smoke')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path, default=ROOT / 'local/fds-run/completed')
    parser.add_argument('--chid', help='Defaults to the only .smv filename in the source directory')
    parser.add_argument('--meshes', nargs='+', type=int, help='1-based mesh numbers; default all')
    parser.add_argument('--files', nargs='+', help='Exact field filenames; overrides the room_corner recipe')
    parser.add_argument('--frames', nargs=3, type=int, help='Default first, middle, last in each file')
    parser.add_argument('--dest', type=Path, default=ROOT / 'fixtures/fds-results')
    args = parser.parse_args()
    source, dest = args.source.resolve(), args.dest.resolve()
    if source == dest:
        raise ValueError('Source and destination must differ')
    if args.chid:
        if Path(args.chid).name != args.chid or any(c in args.chid for c in '/\\:'):
            raise ValueError('CHID must be a filename stem')
        chid = args.chid
    else:
        smvs = sorted(source.glob('*.smv'))
        if len(smvs) != 1:
            raise ValueError('Specify --chid when source does not have exactly one .smv')
        chid = smvs[0].stem
    log = (source / (chid + '.out')).read_text(encoding='utf-8')
    if 'FDS completed successfully' not in log or 'FDS-6.9.1' not in log:
        raise ValueError('Require a successfully completed FDS 6.9.1 run')
    raw_lines = (source / (chid + '.smv')).read_bytes().splitlines(keepends=True)
    lines = [line.decode('utf-8').rstrip('\r\n') for line in raw_lines]
    fields = inventory(lines)
    wanted = set(args.files or [f'{chid}_{suffix}' for suffix in DEFAULT_FIELDS])
    if wanted - {f['file'] for f in fields}:
        raise ValueError('Requested fields are missing; specify --files for a different case')
    chosen = [f for f in fields if (not args.meshes or f['mesh'] in args.meshes) and f['file'] in wanted]
    if not chosen or (args.files and set(args.files) != {f['file'] for f in chosen}):
        raise ValueError('Selection contains missing fields or has no fields')
    if args.meshes and set(args.meshes) - {f['mesh'] for f in chosen}:
        raise ValueError('Selection contains missing meshes')
    outputs, extracted, full_frames = {}, [], {}
    for field in fields:
        layout = (smoke_layout if field['kind'] == 'smoke' else scalar_layout)(source / field['file'])
        full_frames[field['file']] = len(layout[1])
        if field in chosen:
            files, info = extract_field(source, field, args.frames)
            outputs.update(files)
            extracted.append(info)
    names = {f['file'] for f in chosen}
    kept, i = [], 0
    while i < len(lines):
        parts = lines[i].split()
        tag = parts[0] if parts else ''
        if tag in FIELD_TAGS:
            if lines[i+1].strip() in names:
                kept.extend(raw_lines[i:i+5])
            i += 5
        elif tag == 'CSVF' and lines[i+1].strip() not in ('devc', 'hrr'):
            i += 3
        else:
            kept.append(raw_lines[i])
            i += 1
    outputs[chid + '.smv'] = b''.join(kept)
    csv_info = {}
    for kind in ('devc', 'hrr'):
        name = f'{chid}_{kind}.csv'
        rows = (source / name).read_bytes().splitlines(keepends=True)
        times = [float(row.split(b',')[0]) for row in rows[2:]]
        if len(times) < 3 or not all(math.isfinite(t) for t in times) or any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError('Need a complete, monotonic CSV history')
        middle = (times[0] + times[-1]) / 2
        selected = [0, min(range(len(times)), key=lambda n: abs(times[n] - middle)), len(times)-1]
        outputs[name] = b''.join(rows[:2] + [rows[n+2] for n in selected])
        csv_info[name] = {'sourceRows': len(times), 'indices': selected, 'times': [times[n] for n in selected]}
    # Windows FDS emits CRLF. Preserve every text value and its fixed-width padding,
    # changing only line terminators; binary Fortran records never pass this path.
    for name in outputs:
        if name.endswith(('.smv', '.csv', '.sz', '.bnd')):
            outputs[name] = outputs[name].replace(b'\r\n', b'\n')
    input_bytes = (source / (chid + '.fds')).read_bytes()
    manifest = {'chid': chid, 'inputSha256': sha256(input_bytes),
                'fullCounts': counts(fields), 'fullFrames': full_frames,
                'subsetCounts': counts(chosen), 'fields': extracted, 'csv': csv_info,
                'files': {name: {'bytes': len(data), 'sha256': sha256(data)} for name, data in sorted(outputs.items())}}
    outputs['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode('utf-8')
    # Validate everything before writing; never delete unrelated destination files.
    for name, data in outputs.items():
        if name.endswith(('.smv', '.csv', '.sz', '.bnd', '.json')) and b'\r' in data:
            raise ValueError(f'{name}: unsupported bare CR in source text')
    dest.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (dest / name).write_bytes(data)
    print(f'{chid}: {counts(fields)} full; {counts(chosen)} kept')
    print(f'Wrote {len(outputs)} files, {sum(map(len, outputs.values())):,} bytes to {dest}')


if __name__ == '__main__':
    main()
