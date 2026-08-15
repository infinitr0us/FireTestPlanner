"""Make `fireplan` importable when running pytest from the repo root, without
requiring an install. `pip install -e python/` also works and takes precedence.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "python"))
