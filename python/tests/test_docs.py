"""Documentation that states facts about the format is checked against it.

PLAN.md's file-format example drifted into something no 1.x schema accepted -- a
degree-valued azimuth, prose where the schema has constants, a stored field of view
-- while it was the first example of the format anyone read (review 2026-09-22,
EXP-14).
"""

from __future__ import annotations

import os
import re

from fireplan import Plan

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")


def _plan_example() -> str:
    with open(os.path.join(ROOT, "PLAN.md"), encoding="utf-8") as f:
        text = f.read()
    section = text[text.index("## 4. File format"):]
    block = re.search(r"```jsonc\n(.*?)```", section, re.S)
    assert block, "PLAN.md section 4 has no jsonc example"
    # Comments are the only thing jsonc adds; none of them sits inside a string.
    return re.sub(r"\s*//[^\n]*", "", block.group(1))


def test_the_plan_md_example_is_a_valid_plan():
    plan = Plan.loads(_plan_example())
    plan.validate_schema()
    assert plan.data["version"] == plan.effective_version == "1.0.0"
    # And a sensible one: the camera's quaternion agrees with its aim target, and
    # nothing in it trips a check.
    assert [(i.code, i.message) for i in plan.check()] == []
