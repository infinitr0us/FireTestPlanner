"""Survey validation and set-out comparison, independent of planning geometry."""
from datetime import date
import math
import re
import numpy as np
from .objects import wrap


def problem(obj):
    if 'asBuilt' not in obj:
        return None
    a = obj['asBuilt']
    if not isinstance(obj.get('transform'), dict) or not isinstance(a, dict):
        return 'As built requires a planned transform and a survey record.'
    # JSON Schema's number type includes NaN/Infinity on Python dictionaries.
    # JSON text cannot contain them, and the web validator refuses them too.
    transform = a.get('transform') or {}
    for key in ('position_m', 'rotation_quat', 'aimTarget_m'):
        values = transform.get(key)
        if isinstance(values, list) and any(not isinstance(v, (int, float))
                or isinstance(v, bool) or not math.isfinite(v) for v in values):
            return 'As-built transform values must be finite numbers.'
    measured = a.get('measured')
    if measured is not None:
        try:
            if not isinstance(measured, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', measured):
                raise ValueError()
            date.fromisoformat(measured)
        except ValueError:
            return 'Measured date must be a calendar date in YYYY-MM-DD form or null.'
    return None


def set_out_check(plan):
    rows = []
    for o in plan.objects:
        a = o.raw.get('asBuilt')
        if a is None or 'transform' not in o.raw:
            continue
        measured = wrap(dict(o.raw, transform=a['transform']))
        delta = measured.position - o.position
        aimed = o.type in ('camera', 'heatFluxSensor', 'velocityProbe')
        if o.type == 'velocityProbe':
            aimed = 'rotation_quat' in o.raw['transform'] and 'rotation_quat' in a['transform']
        angle = math.degrees(math.acos(float(np.clip(np.dot(o.forward, measured.forward), -1, 1)))) if aimed else None
        rows.append(dict(id=o.id, name=o.name, planned=o.position.tolist(), measured=measured.position.tolist(),
            plan_distance_m=float(np.hypot(delta[0], delta[1])), height_difference_m=float(delta[2]),
            aim_difference_deg=angle, date=a['measured']))
    return rows


def next_test_id(value):
    text = value or ''
    match = re.search(r'[0-9]+$', text)
    if not match:
        return text + '-2'
    return text[:match.start()] + str(int(match[0]) + 1).zfill(len(match[0]))
