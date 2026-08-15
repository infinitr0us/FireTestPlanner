"""Make `fireplan` importable without an install.

This lives beside the tests rather than at the repo root on purpose: `python/
pyproject.toml` carries a `[tool.pytest.ini_options]` section, so pytest resolves
its rootdir to `python/` and will not look above it for conftest files. A root-level
conftest is silently ignored when tests are run as `pytest python/tests`.

`pip install -e python/` also works and takes precedence over this.
"""

import os
import sys

_PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, _PACKAGE_ROOT)
