"""Check the current device writer with FDS, without running a simulation.

Run from any directory: python tools/check_fds_device_export.py
FDS_BIN may name the executable or its bin directory. When it is unset, use the
portable FDS 6.9.1 installation documented in CONVENTIONS.md. Missing default
installations are reported as skipped; an invalid explicit FDS_BIN is an error.
All generated input and FDS output stay in a temporary directory under local/.
"""
from __future__ import annotations

import argparse
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

from fireplan._math import look_at_quat
from fireplan import Plan, namelist  # noqa: E402

DEFAULT_BIN = Path('C:/Program Files/firemodels/FDS6/bin')


def setup_input() -> str:
    """Keep source geometry and properties, replace devices, and stop after setup."""
    source = (ROOT / 'fixtures/fds/room_corner.fds').read_text(encoding='utf-8')
    plan = Plan.load(ROOT / 'fixtures/fds/room_corner.ftp.json')
    gauge = plan.heat_flux_sensors[0]
    tilted = dict(gauge.raw, id='tilted-setup-gauge', name='Tilted setup gauge')
    normal = [math.sin(math.radians(30)), math.cos(math.radians(30)), 0]
    tilted['transform'] = dict(gauge.raw['transform'], rotation_quat=look_at_quat(gauge.position, gauge.position + normal).tolist())
    plan.add(tilted)
    exported = plan.to_fds_devices()
    assert "ID='Tilted setup gauge'" in exported and 'factor cos(tilt)' in exported
    extra = Plan.load(ROOT / 'fixtures/instruments17.ftp.json')
    for obj in extra.objects:
        obj.position = [2.2, 4.0, 1.5]
    exported += '\n' + extra.to_fds_devices()
    parts, cursor, times = [], 0, 0
    for record in namelist.read(source):
        if record.group not in ('DEVC', 'TIME', 'TAIL'):
            continue
        parts.append(source[cursor:record.start])
        if record.group == 'TIME':
            parts.append('&TIME T_END=0. /')
            times += 1
        cursor = record.end
    if times != 1:
        raise ValueError('Expected exactly one TIME record in room_corner.fds')
    parts.extend([source[cursor:], '\n', exported, '\n&TAIL /\n'])
    return ''.join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=float, default=120, help='FDS timeout in seconds (default: 120)')
    args = parser.parse_args()
    configured = os.environ.get('FDS_BIN')
    binary = Path(configured) if configured else DEFAULT_BIN
    if binary.is_dir():
        binary /= 'fds.exe' if os.name == 'nt' else 'fds'
    if not binary.is_file():
        if configured:
            print('FAIL: FDS_BIN does not identify an FDS executable: {}'.format(binary), file=sys.stderr)
            return 1
        print('SKIP: FDS was not found at {}. Set FDS_BIN to its executable or bin directory.'.format(DEFAULT_BIN))
        return 0
    binary = binary.resolve()
    # Keep all generated files in the worktree, including temporary cleanup.
    local = (ROOT / 'local').resolve()
    local.relative_to(ROOT)
    local.mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='fds-device-export-', dir=str(local)) as temporary:
            work = Path(temporary).resolve()
            work.relative_to(local)
            with (work / 'devices.fds').open('w', encoding='utf-8', newline='\n') as stream:
                stream.write(setup_input())
            env = os.environ.copy()
            env['OMP_NUM_THREADS'] = '1'
            command = [str(binary), 'devices.fds']
            init = binary.parent / 'fdsinit.bat'
            if os.name == 'nt' and init.is_file():
                env['FIREPLAN_FDS_INIT'] = str(init)
                env['FIREPLAN_FDS_EXE'] = str(binary)
                # A local wrapper avoids cmd.exe /c versus C-runtime quote rules.
                # Installation paths remain quoted environment values.
                with (work / 'run-fds.cmd').open('w', encoding='utf-8', newline='\n') as stream:
                    stream.write('@echo off\ncall "%FIREPLAN_FDS_INIT%"\n'
                                 'if errorlevel 1 exit /b 1\n'
                                 '"%FIREPLAN_FDS_EXE%" devices.fds\nexit /b %errorlevel%\n')
                command = [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', '.\\run-fds.cmd']
            print('FDS executable: {}'.format(binary), flush=True)
            result = subprocess.run(command, cwd=str(work), env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, encoding='utf-8', errors='replace',
                                    timeout=args.timeout, check=False)
            print(result.stdout, end='' if result.stdout.endswith('\n') else '\n')
            output = work / 'room_corner.out'
            report = output.read_text(encoding='utf-8', errors='replace') if output.is_file() else ''
            # Some FDS builds put the stop message in the .out file only.
            for line in report.splitlines():
                if re.search(r'Set-up only|\bERROR\b|\bWARNING\b', line, re.IGNORECASE) and line not in result.stdout:
                    print(line)
            combined = result.stdout + '\n' + report
            if (result.returncode != 0 or not re.search(r'Set-up only', combined, re.IGNORECASE)
                    or re.search(r'\bERROR\b', combined, re.IGNORECASE)):
                print('FAIL: FDS must exit successfully, report Set-up only and contain no ERROR line.', file=sys.stderr)
                return 1
            print('PASS: FDS reported Set-up only with no ERROR line.')
            return 0
    except subprocess.TimeoutExpired as exc:
        captured = exc.stdout or b''
        print(captured.decode('utf-8', errors='replace') if isinstance(captured, bytes) else captured)
        print('FAIL: FDS exceeded {} seconds.'.format(args.timeout), file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print('FAIL: {}'.format(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
