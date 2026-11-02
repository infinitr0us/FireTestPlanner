"""Deterministic instrument-only FDS writer, mirrored in core/fds-export.ts."""
from __future__ import annotations

import re
import math
from .fds import FDS_SPECIES
from decimal import Decimal, ROUND_HALF_UP

from .objects import HeatFluxSensor, Thermocouple, VelocityProbe, GasSampling, LoadCell
from .occlusion import mounting_ior, nearest_mounting_ior
from .serialize import _js_number, _round_micro


def _metres(value):
    return _js_number(_round_micro(float(value)))


def _one_line(text):
    return re.sub(r"[\x00-\x1f\x7f\u2028\u2029]", " ", text)


def _orientation(value):
    rounded = Decimal(float(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    return format(rounded.copy_abs() if rounded == 0 else rounded, ".4f")


def _imported_bead_ids(name, count):
    """Recover consecutive source device IDs from the importer's range name."""
    match = re.fullmatch(r"(.*?)([0-9]+)-\1([0-9]+)", name)
    if match is None:
        return None
    prefix, first, last = match.groups()
    first, last = int(first), int(last)
    if first >= last or last - first + 1 != count:
        return None
    return [_one_line(prefix + str(i)).replace("'", "_") for i in range(first, last + 1)]


def devices_to_fds(plan) -> str:
    meta = plan.data.get("meta") or {}
    source = meta.get("source") or {}
    offset = source.get("originOffset_m") or [0, 0, 0]
    lines = [
        "! Plan: " + _one_line(meta.get("title") if meta.get("title") is not None else "Untitled"),
        "! Test ID: " + _one_line(meta.get("testId") if meta.get("testId") is not None else "(none)"),
        "! Instruments only: no geometry, mesh, surfaces or reactions",
        "! coordinates in the source FDS file's frame" if source.get("tool") == "FDS"
        else "! plan frame: origin at the burner centre at floor level",
        "! Written by FireTestPlanner",
    ]
    props, devices, taken = {}, [], set()
    bases = set()

    def unique(base, count, imported_ids=None, species=None):
        suffix = 1
        while True:
            name = base if suffix == 1 else "{}_{}".format(base, suffix)
            ids = [name + "_" + s for s in species] if species is not None else imported_ids if suffix == 1 and imported_ids is not None else (
                [name] if count == 1 else ["{}_{}".format(name, i + 1) for i in range(count)])
            if name not in bases and all(v not in taken for v in ids):
                bases.add(name)
                taken.update(ids)
                return ids
            suffix += 1

    def xyz(position):
        return ",".join(_metres(v + offset[i]) for i, v in enumerate(position))

    objects = plan.objects
    for obj in objects:
        if not isinstance(obj, (HeatFluxSensor, Thermocouple, VelocityProbe, GasSampling, LoadCell)):
            continue
        base = _one_line(obj.raw.get("name") or obj.id).replace("'", "_")
        if isinstance(obj, LoadCell):
            devices.append('! {}: load cell omitted; no FDS device equivalent.'.format(_one_line(obj.name)))
        elif isinstance(obj, GasSampling):
            names = unique(base, len(obj.species), species=obj.species)
            devices.append('! {}: FDS needs each sampled species defined.'.format(_one_line(obj.name)))
            for name, species in zip(names, obj.species):
                devices.append("&DEVC ID='{}', XYZ={}, QUANTITY='VOLUME FRACTION', SPEC_ID='{}' /".format(name, xyz(obj.position), FDS_SPECIES[species]))
        elif isinstance(obj, VelocityProbe):
            name, = unique(base, 1)
            normal = obj.axis
            axis = max(range(3), key=lambda i: abs(normal[i])) if normal is not None else -1
            aligned = normal is not None and abs(normal[axis]) >= math.cos(math.radians(5)) - 1e-10
            quantity = ['U-VELOCITY', 'V-VELOCITY', 'W-VELOCITY'][axis] if aligned else 'VELOCITY'
            if not aligned:
                devices.append('! {}: {}; exporting velocity magnitude.'.format(name,
                    'axis is more than 5 degrees from an FDS axis' if normal is not None else 'no axis recorded'))
            elif normal[axis] < 0:
                devices.append('! {}: probe points along negative {}; FDS reports the positive-axis component.'.format(name, 'XYZ'[axis]))
            devices.append("&DEVC ID='{}', XYZ={}, QUANTITY='{}' /".format(name, xyz(obj.position), quantity))
        elif isinstance(obj, HeatFluxSensor):
            name, = unique(base, 1)
            normal = obj.normal
            normal = normal / sum(float(v) ** 2 for v in normal) ** 0.5
            ior = mounting_ior(objects, obj.position, normal)
            quantity = "RADIATIVE HEAT FLUX GAS" if ior is None else "GAUGE HEAT FLUX"
            direction = ",".join(_orientation(v) for v in normal)
            tilted = ior is not None and any(_orientation(v) != _orientation(
                (1 if ior > 0 else -1) if i == abs(ior) - 1 else 0) for i, v in enumerate(normal))
            facing = "ORIENTATION=" + direction if ior is None else "IOR={}".format(ior)
            if tilted:
                facing += ", ORIENTATION=" + direction
            devices.append("&DEVC ID='{}', XYZ={}, QUANTITY='{}', {} /".format(name, xyz(obj.position), quantity, facing))
        else:
            beads = obj.bead_positions
            ids = unique(base, len(beads), _imported_bead_ids(obj.raw.get("name") or "", len(beads)))
            diameter = obj.bead_diameter_mm
            surface = (obj.raw.get('mount') or {}).get('type') in ('wall', 'ceiling')
            for name, bead in zip(ids, beads):
                ior = nearest_mounting_ior(objects, bead) if surface else None
                if ior is not None:
                    devices.append("&DEVC ID='{}', XYZ={}, QUANTITY='WALL TEMPERATURE', IOR={} /".format(name, xyz(bead), ior))
                    continue
                if surface:
                    devices.append("! {}: surface thermocouple with no surface in the plan at that point.".format(name))
                prop = ""
                if diameter is not None:
                    if diameter not in props:
                        props[diameter] = "TC {} mm".format(_js_number(diameter))
                    prop = ", PROP_ID='{}'".format(props[diameter])
                devices.append("&DEVC ID='{}', XYZ={}, QUANTITY='THERMOCOUPLE'{} /".format(name, xyz(bead), prop))
    lines.append("")
    for diameter, name in props.items():
        lines.append("&PROP ID='{}', DIAMETER={} /".format(name, _metres(diameter / 1000)))
    if props:
        lines.append("")
    lines.extend(devices or ["! No instruments: nothing to export."])
    return "\n".join(lines) + "\n"
