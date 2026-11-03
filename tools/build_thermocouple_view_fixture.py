"""Build the shared, synthetic camera/bead geometry fixture with the canonical writer.

    python tools/build_thermocouple_view_fixture.py
"""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from fireplan import Plan  # noqa: E402


def build() -> Plan:
    plan = Plan.new("Thermocouple image geometry")
    plan.meta["created"] = plan.meta["modified"] = "2026-11-02T00:00:00Z"
    plan.add({
        "id": "burner", "type": "burner", "name": "Synthetic burner",
        "transform": {"position_m": [0, 0, 0]},
        "footprint": {"shape": "square", "size_m": [0.2, 0.2]},
        "fire": {"hrr_kw": 100},
    })
    camera = plan.add({
        "id": "camera", "type": "camera", "name": "Synthetic IR camera",
        "transform": {"position_m": [0, -10.5, 1]},
        "camera": {
            "modality": "LWIR", "resolution_px": [1000, 750],
            "sensor_mm": [20, 15], "focalLength_mm": 50,
            "principalPoint_px": None, "distortion": None,
            "intrinsicsSource": "nominal",
        },
    })
    camera.aim_at([0, 0, 1])
    plan.add({
        "id": "pack", "type": "obstruction", "name": "Synthetic pack",
        "transform": {"position_m": [0, 0, 0]}, "size_m": [2, 1, 2],
    })
    # Near face y=-0.5 is 10 m down the optical axis, fx=fy=2500 px.
    # TC-01/02 are 20 mm apart, hence 2500 * 0.02 / 10 = 5 px.
    for index, position in enumerate([
        [0, -0.5, 1], [0.02, -0.5, 1], [0.3, -0.5, 1.2],
        [0, 0.5, 1], [8, -0.5, 1],
    ], start=1):
        plan.add({
            "id": f"tc-{index:02d}", "type": "thermocouple", "name": f"TC-{index:02d}",
            "transform": {"position_m": position}, "beadOffsets_m": [0],
            "thermocouple": {"tcType": "K"},
        })
    return plan


if __name__ == "__main__":
    path = ROOT / "fixtures" / "thermocouple-view.ftp.json"
    plan = build()
    plan.save(path, update_modified=False)
    Plan.load(path).validate_schema()
    print(path)
