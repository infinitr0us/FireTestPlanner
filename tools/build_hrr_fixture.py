"""Rebuild the format 1.7 cross-engine HRR examples and prediction references."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from fireplan import Plan, fds, t2_curve, curve_from_series


def build():
    models = [
        ("ramp-below-one", "HRRPUA=100 RAMP_Q='F'", "&RAMP ID='F' T=0 F=0 /\n&RAMP ID='F' T=10 F=.5 /"),
        ("ramp-above-one", "HRRPUA=100 RAMP_Q='F'", "&RAMP ID='F' T=0 F=.2 /\n&RAMP ID='F' T=10 F=2 /"),
        ("mass-loss", "MLRPUA=.01 HEAT_OF_COMBUSTION=40000 RAMP_Q='F'", "&RAMP ID='F' T=0 F=0 /\n&RAMP ID='F' T=10 F=.5 /"),
        ("tau-negative", "HRRPUA=100 TAU_Q=-40", ""),
        ("tau-positive", "HRRPUA=100 TAU_Q=40", ""),
        ("controlled", "HRRPUA=100 RAMP_Q='F'", "&RAMP ID='F' T=0 F=0 DEVC_ID='probe' /\n&RAMP ID='F' T=10 F=.5 /"),
        ("temperature", "HRRPUA=100 RAMP_Q='F'", "&RAMP ID='F' TMP=0 F=0 /\n&RAMP ID='F' TMP=100 F=.5 /"),
        ("duplicates", "HRRPUA=100 RAMP_Q='F'", "&RAMP ID='F' T=0 F=0 /\n&RAMP ID='F' T=0 F=.5 /"),
    ]
    imports = []
    inputs = [(name, f"&SURF ID='B' {surf} /\n&VENT XB=0,2,0,1,0,0 SURF_ID='B' /\n{ramp}\n") for name, surf, ramp in models]
    inputs.append(('controlled-vent', inputs[0][1].replace("SURF_ID='B' /", "SURF_ID='B' CTRL_ID='switch' /")))
    inputs.append(('react-combustion', inputs[2][1].replace(' HEAT_OF_COMBUSTION=40000', '') + '&REAC HEAT_OF_COMBUSTION=40000 /\n'))
    inputs.append(('mixed-side-curves', "&SURF ID='TOP' HRRPUA=100 RAMP_Q='UP' /\n"
                   "&SURF ID='SIDE' HRRPUA=50 RAMP_Q='DOWN' /\n"
                   "&OBST XB=0,1,0,1,0,1 SURF_IDS='TOP','SIDE','INERT' /\n"
                   "&RAMP ID='UP' T=0 F=0 /\n&RAMP ID='UP' T=10 F=1 /\n"
                   "&RAMP ID='DOWN' T=0 F=1 /\n&RAMP ID='DOWN' T=10 F=0 /\n"))
    for name, text in inputs:
        result = fds.to_plan(text, "case.fds", fds.ImportOptions(imported_at="2026-08-15T00:00:00Z"))
        result.plan.meta["created"] = result.plan.meta["modified"] = "2026-08-15T00:00:00Z"
        imports.append({"name": name, "input": text, "output": result.plan.dumps()})
    p = Plan.new("HRR predictions")
    p.meta["created"] = p.meta["modified"] = "2026-08-15T00:00:00Z"
    p.data["objects"] = [
        {"id": "b", "type": "burner", "footprint": {"shape": "circle", "diameter_m": .4},
         "fire": {"hrr_kw": 400, "hrrCurve": {"source": "test", "points": [[0, 0], [10, 400], [30, 0]]}}},
        {"id": "b2", "type": "burner", "footprint": {"shape": "circle", "diameter_m": .2}, "transform": {"position_m": [1, 0, 0]},
         "fire": {"hrr_kw": 200, "hrrCurve": {"points": [[0, 200], [20, 0], [30, 100]]}}},
        {"id": "g", "type": "heatFluxSensor", "transform": {"position_m": [-4, 0, 1]}},
        {"id": "tc", "type": "thermocouple", "transform": {"position_m": [0, 0, 4]}, "beadOffsets_m": [0, 1]},
        {"id": "wall", "type": "wall", "polyline_m": [[0, -2], [0, 2]], "height_m": .6, "thickness_m": .1,
         "transform": {"position_m": [-2, 0, 0]}},
    ]
    p.heat_flux_sensors[0].aim_at([0, 0, 1])
    predictions = []
    for t in [0, 2, 5, 10, 20, 30]:
        predictions.append({"t": t, "flux": p.heat_flux_estimate(p.heat_flux_sensors[0], t)["incident_kw_m2"],
                            "beads": [b["gas_temperature_c"] for b in p.thermocouple_beads(p.thermocouples[0], t)],
                            "height": p.burner.flame_height_m(t)})
    return {"imports": imports, "plan": p.dumps(), "predictions": predictions,
            "t2": t2_curve(alpha_kW_s2=.0469, peak_kW=300, hold_s=25, decay_s=45),
            "measured": curve_from_series(list(range(12)), [-1, 0, 10, 2, 20, 3, 30, 4, 40, 5, 50, 0], 8)}


if __name__ == "__main__":
    destination = ROOT / "fixtures" / "hrr" / "parity.json"
    destination.parent.mkdir(exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(build(), f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(destination)
