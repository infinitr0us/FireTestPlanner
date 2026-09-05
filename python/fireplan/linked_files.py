"""Local attachment paths and constraints beyond JSON Schema."""
from __future__ import annotations

from copy import deepcopy
import math
import ntpath
import os
import re

LINK_TYPES = {'burner', 'camera', 'heatFluxSensor', 'thermocouple'}


def local_path(path):
    return (isinstance(path, str) and bool(path.strip())
            and not re.search(r'[\x00-\x1f]', path)
            and not re.match(r'^[a-z][a-z0-9+.-]*:', re.sub(r'^[a-z]:[/\\]', '', path, flags=re.I), re.I))


def resolve_path(path, plan_path=None):
    if not local_path(path):
        raise ValueError('Linked files need local paths, not URLs.')
    path_module = ntpath if ntpath.splitdrive(path)[0] or (plan_path and ntpath.splitdrive(str(plan_path))[0]) else os.path
    if path_module.isabs(path):
        return path_module.normpath(path)
    if not plan_path:
        raise ValueError('A relative link needs a plan loaded from or saved to a file.')
    return path_module.normpath(path_module.join(path_module.dirname(path_module.abspath(str(plan_path))), path))


def for_destination(data, source_path, destination):
    """Rebase a COPY for Save As. No source or attachment bytes are touched."""
    result = deepcopy(data)
    for obj in result.get('objects', []):
        if obj.get('type') not in LINK_TYPES:
            continue
        for link in obj.get('linkedFiles', []):
            absolute = resolve_path(link['path'], source_path or destination)
            module = ntpath if ntpath.splitdrive(absolute)[0] or ntpath.splitdrive(str(destination))[0] else os.path
            try:
                link['path'] = module.relpath(absolute, module.dirname(module.abspath(str(destination)))).replace('\\', '/')
            except ValueError:  # different Windows drives
                link['path'] = absolute.replace('\\', '/')
    return result


def problems(data):
    """Assumes schema-valid shapes. Strict time order and unique IDs need code."""
    for obj in data.get('objects', []):
        if obj.get('type') not in LINK_TYPES:
            continue
        seen = set()
        for link in obj.get('linkedFiles', []):
            if link['id'] in seen:
                yield '{}: linked file IDs must be unique within their object'.format(obj['id'])
            seen.add(link['id'])
            if not local_path(link['path']):
                yield '{}: linked files need a local path, not a URL'.format(obj['id'])
            previous = -math.inf
            for sample in link.get('plot', {}).get('samples', []):
                if not all(math.isfinite(x) and x >= 0 for x in sample) or sample[0] <= previous:
                    yield '{}: plot samples need finite, non-negative values and strictly increasing timestamps'.format(obj['id'])
                    break
                previous = sample[0]
