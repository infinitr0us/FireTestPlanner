"""Reading FDS input, and turning it into a plan.

Two layers, tested separately because they fail differently. The namelist reader
either understands the file's syntax or silently loses parameters -- and losing one
looks exactly like the file not having it. The mapping either puts geometry where
the file put it or moves the whole model, and an origin that is 100 mm out is
invisible in a screenshot and wrong in every dimension on the drawing.

The sample input in `fixtures/fds/` is a real case from a fire safety engineer, not
a synthesised one, and it exercises all three of the syntax traps in the reader's
docstring. That is why it is the fixture.
"""

from __future__ import annotations

import json
import os

import pytest

from fireplan import Plan, fds, namelist
from fireplan.namelist import NamelistError

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SAMPLE = os.path.join(ROOT, "fixtures", "fds", "IR401_0.fds")
GOLDEN = os.path.join(ROOT, "fixtures", "fds", "IR401_0.ftp.json")


@pytest.fixture(scope="module")
def sample():
    return fds.load(SAMPLE, fds.ImportOptions(imported_at="2026-08-15T00:00:00Z"))


def one(result, kind):
    objs = [o for o in result.plan.data["objects"] if o["type"] == kind]
    assert len(objs) == 1, "expected exactly one {}, got {}".format(kind, len(objs))
    return objs[0]


def by_id(result, obj_id):
    return next(o for o in result.plan.data["objects"] if o["id"] == obj_id)


# -- the namelist reader --------------------------------------------------

def test_a_slash_inside_a_quoted_string_does_not_end_the_record():
    # The sample's own &HEAD title contains "34.2x1000/300=114s". A reader that
    # stops at the first slash truncates the first record in the file and loses
    # every parameter after it.
    text = "&HEAD CHID='x', TITLE='burnout=34.2/300=114s' /\n&TIME T_END=60. /"
    records = namelist.read(text)
    assert [r.group for r in records] == ["HEAD", "TIME"]
    assert records[0].string("TITLE") == "burnout=34.2/300=114s"
    assert records[1].number("T_END") == 60.0


def test_parameters_separate_on_whitespace_as_well_as_commas():
    # The sample's &SURF, &MATL and &PROP records use newlines and no commas, so a
    # comma-splitter reads the whole body as one value of the first parameter.
    text = "&SURF ID = 'FIRE'\n      COLOR = 'RED'\n      HRRPUA = 7500. /"
    rec = namelist.read(text)[0]
    assert rec.string("ID") == "FIRE"
    assert rec.string("COLOR") == "RED"
    assert rec.number("HRRPUA") == 7500.0


def test_a_line_without_an_ampersand_is_a_comment():
    # This is how an FDS line gets disabled, and the sample does exactly this to a
    # REAC carrying RADIATIVE_FRACTION=0.29. Reading it would change every predicted
    # heat flux in the plan.
    text = "REAC FUEL='PROPANE', RADIATIVE_FRACTION=0.29 /\n&REAC FUEL='POLYURETHANE' /"
    records = namelist.read(text)
    assert len(records) == 1
    assert records[0].string("FUEL") == "POLYURETHANE"
    assert records[0].number("RADIATIVE_FRACTION") is None


def test_repeat_counts_expand():
    rec = namelist.read("&OBST SURF_ID6=6*'WALL' /")[0]
    assert rec.strings("SURF_ID6") == ["WALL"] * 6


def test_subscripted_assignments_accumulate_rather_than_overwrite():
    rec = namelist.read("&SURF ID='S', MATL_ID(1,1)='GYP', MATL_ID(2,1)='WOOL',"
                        " THICKNESS(1:2)=0.012,0.2 /")[0]
    assert rec.strings("MATL_ID") == ["GYP", "WOOL"]
    assert rec.numbers("THICKNESS") == [0.012, 0.2]


def test_logicals_and_fortran_exponents():
    rec = namelist.read("&SURF DEFAULT=.TRUE., X=.F., C=1.2D3, D=4.5e-2 /")[0]
    assert rec.boolean("DEFAULT") is True
    assert rec.boolean("X") is False
    assert rec.number("C") == 1200.0
    assert rec.number("D") == 0.045


def test_a_doubled_quote_is_an_escaped_quote():
    rec = namelist.read("&HEAD TITLE='Bob''s test' /")[0]
    assert rec.string("TITLE") == "Bob's test"


def test_reading_stops_at_tail():
    records = namelist.read("&OBST XB=0,1,0,1,0,1 /\n&TAIL /\n&OBST XB=9,9,9,9,9,9 /")
    assert [r.group for r in records] == ["OBST", "TAIL"]


def test_an_unsubscripted_rewrite_replaces_the_whole_value():
    rec = namelist.read("&X A=1,2,3, A=9 /")[0]
    assert rec.numbers("A") == [9.0]


def test_read_one_names_the_mistake_people_actually_make():
    with pytest.raises(NamelistError) as excinfo:
        namelist.read_one("OBST XB=0,1,0,1,0,2 /")
    assert "no '&' to start the record" in str(excinfo.value)

    with pytest.raises(NamelistError):
        namelist.read_one("&OBST XB=0,1,0,1,0,2 /\n&OBST XB=1,2,0,1,0,2 /")
    with pytest.raises(NamelistError):
        namelist.read_one("   ")


# -- the sample, end to end ------------------------------------------------

def test_the_sample_converts_to_a_valid_plan(sample):
    sample.plan.validate_schema()
    assert sample.counts == {
        "wall": 4, "ceiling": 1, "burner": 1, "heatFluxSensor": 23, "thermocouple": 2,
    }
    assert not sample.errors


def test_the_origin_lands_on_the_burner_centre_at_floor_level(sample):
    # The fire is a 0.2 m square at (0.1, 0.1) standing on a slab whose top is z=0,
    # so the whole model shifts by (-0.1, -0.1, 0).
    assert sample.origin_m == pytest.approx((0.1, 0.1, 0.0))
    burner = one(sample, "burner")
    assert burner["transform"]["position_m"] == pytest.approx([0.0, 0.0, 0.0])
    assert sample.plan.meta["source"]["originOffset_m"] == pytest.approx([0.1, 0.1, 0.0])


def test_the_floor_is_the_slab_top_not_the_bottom_of_the_mesh(sample):
    # The meshes start at z = -0.2 and the floor slab's top is z = 0. Taking the mesh
    # would put every height in the plan 200 mm out and leave the burner floating.
    assert sample.origin_m[2] == 0.0
    assert one(sample, "ceiling")["height_m"] == pytest.approx(2.4)


def test_hrr_comes_from_hrrpua_times_area_times_the_ramp_peak(sample):
    # SURF 'FIRE' is 7500 kW/m2 over a 0.2 x 0.2 m face, and RAMP 'fire_ramp' peaks
    # at F = 1.0, so 300 kW.
    burner = one(sample, "burner")
    assert burner["fire"]["hrr_kw"] == pytest.approx(300.0)
    assert burner["footprint"] == {"shape": "square", "size_m": pytest.approx([0.2, 0.2])}
    assert burner["rimHeight_m"] == pytest.approx(0.1)
    assert burner["fire"]["fuel"] == "polyurethane"


def test_a_ramp_that_never_reaches_one_scales_the_heat_release():
    text = ("&SURF ID='B', HRRPUA=1000., RAMP_Q='r' /\n"
            "&RAMP ID='r', T=0., F=0. /\n&RAMP ID='r', T=60., F=0.4 /\n"
            "&OBST XB=0,1,0,1,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
            "&SURF ID='I' /\n")
    result = fds.to_plan(text)
    burner = one(result, "burner")
    assert burner["fire"]["hrr_kw"] == pytest.approx(1000.0 * 1.0 * 0.4)


def test_the_radiative_fraction_is_never_invented(sample):
    # The only RADIATIVE_FRACTION in the sample is on a REAC line with no leading '&',
    # which FDS never reads. Nor does this, and it does not substitute FDS's default.
    assert "radiativeFraction" not in one(sample, "burner")["fire"]


def test_an_explicit_radiative_fraction_is_kept():
    text = ("&REAC FUEL='HEPTANE', RADIATIVE_FRACTION=0.35 /\n"
            "&SURF ID='B', HRRPUA=500. /\n&SURF ID='I' /\n"
            "&OBST XB=0,1,0,1,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n")
    assert one(fds.to_plan(text), "burner")["fire"]["radiativeFraction"] == 0.35


# -- geometry --------------------------------------------------------------

def test_a_thin_tall_obstruction_becomes_a_wall_on_its_centreline(sample):
    # &OBST XB=-0.10,2.50, 3.60,3.70, -0.10,2.5 -- 2.6 m long, 0.1 m thick, running
    # along X at y = 3.65, which is 3.55 once the origin moves.
    wall = by_id(sample, "wall-1")
    assert [c for point in wall["polyline_m"] for c in point] == pytest.approx(
        [-0.2, 3.55, 2.4, 3.55])
    assert wall["thickness_m"] == pytest.approx(0.1)
    assert wall["baseHeight_m"] == pytest.approx(0.0)


def test_a_wall_buried_below_the_floor_keeps_its_top_where_the_file_put_it(sample):
    # Every wall in the sample starts at z = -0.1, 100 mm into the slab. Clamping the
    # base to the floor without shortening the wall would put its top at 2.6 m
    # instead of the 2.5 m the file asks for.
    assert by_id(sample, "wall-1")["height_m"] == pytest.approx(2.5)


def test_the_floor_slab_is_not_imported_as_an_object(sample):
    # The floor is the z = 0 plane in this format, not a ceiling at height 0.
    ceilings = [o for o in sample.plan.data["objects"] if o["type"] == "ceiling"]
    assert [c["height_m"] for c in ceilings] == [pytest.approx(2.4)]


def test_a_hole_becomes_an_opening_positioned_along_the_wall(sample):
    # &HOLE XB=0.8,1.6, 3.60,3.80, 0.0,2.0 cuts the wall that starts at x = -0.1.
    openings = by_id(sample, "wall-1")["openings"]
    assert len(openings) == 1
    assert openings[0]["offset_m"] == pytest.approx(0.9)
    assert openings[0]["width_m"] == pytest.approx(0.8)
    assert openings[0]["height_m"] == pytest.approx(2.0)
    assert openings[0]["sillHeight_m"] == pytest.approx(0.0)


def test_a_solid_block_becomes_an_obstruction_with_its_origin_at_the_base_centre():
    text = ("&SURF ID='B', HRRPUA=500. /\n&SURF ID='I' /\n"
            "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
            "&OBST XB=1.0,3.0, 2.0,2.9, 0.0,0.8, ID='Couch' /\n")
    result = fds.to_plan(text)
    box = one(result, "obstruction")
    assert box["name"] == "Couch"
    assert box["size_m"] == pytest.approx([2.0, 0.9, 0.8])
    # centre of the base, re-origined onto the burner at (0.1, 0.1)
    assert box["transform"]["position_m"] == pytest.approx([1.9, 2.35, 0.0])
    assert result.plan.effective_version == "1.2.0"
    result.plan.validate_schema()


def test_an_obstruction_makes_the_plan_declare_1_2():
    plan = Plan.new("boxes")
    assert plan.effective_version == "1.0.0"
    plan.add({"id": "b", "type": "obstruction", "size_m": [1.0, 1.0, 1.0],
              "transform": {"position_m": [0.0, 0.0, 0.0]}})
    assert plan.effective_version == "1.2.0"


def test_a_1_1_tool_keeps_an_obstruction_rather_than_rejecting_the_file():
    # A new object TYPE is the additive path: an older build does not recognise it,
    # holds it verbatim and re-emits it unchanged. That is how heatFluxSensor landed
    # in 1.1, and it is why the 1.1 schema accepts this file even though the plan
    # declares 1.2 -- see CONVENTIONS section 6.
    plan = Plan.new("boxes")
    plan.add({"id": "b", "type": "obstruction", "size_m": [1.0, 1.0, 1.0],
              "transform": {"position_m": [0.0, 0.0, 0.0]}})
    plan.validate_schema("1.1.0")
    plan.validate_schema("1.0.0")

    # What an older tool cannot do is silently drop it or round its numbers.
    text = plan.dumps()
    assert Plan.loads(text).dumps() == text


def test_a_mult_replicates_an_obstruction():
    text = ("&MULT ID='row', DX=1.0, I_LOWER=0, I_UPPER=3 /\n"
            "&OBST XB=0,0.2,0,0.2,0,1.0, MULT_ID='row', ID='post' /\n")
    result = fds.to_plan(text)
    boxes = [o for o in result.plan.data["objects"] if o["type"] == "obstruction"]
    assert len(boxes) == 4
    # Positions are footprint centres, so a 0 -> 0.2 m post sits at 0.1.
    xs = sorted(b["transform"]["position_m"][0] for b in boxes)
    assert xs == pytest.approx([0.1, 1.1, 2.1, 3.1], abs=1e-6)
    assert len({b["id"] for b in boxes}) == 4, "each copy needs its own id"


def test_an_xb_written_backwards_is_normalised():
    # FDS accepts either order; every extent here would otherwise come out negative.
    result = fds.to_plan("&OBST XB=3.0,1.0, 2.9,2.0, 0.8,0.0, ID='c' /\n")
    assert one(result, "obstruction")["size_m"] == pytest.approx([2.0, 0.9, 0.8])


def test_a_surface_that_burns_is_recorded_in_the_notes(sample):
    # The plan has nowhere structured to say "this lining is combustible", and it is
    # exactly the sort of thing that decides where a gauge can survive.
    assert "burns" in by_id(sample, "wall-2")["notes"]
    assert "UPHOLSTERY" in by_id(sample, "wall-2")["notes"]


# -- devices ---------------------------------------------------------------

def test_a_thermocouples_quantity_is_found_through_its_prop(sample):
    # &DEVC PROP_ID='TC' carries no QUANTITY of its own. Every thermocouple in the
    # sample is written this way, so a reader that only looks at QUANTITY imports none.
    rake = by_id(sample, "tc-tc1-tc22")
    assert rake["thermocouple"]["beadDiameter_mm"] == pytest.approx(3.2)


def test_a_vertical_run_of_devices_becomes_one_rake(sample):
    rake = by_id(sample, "tc-tc1-tc22")
    assert len(rake["beadOffsets_m"]) == 22
    assert rake["beadOffsets_m"][0] == 0.0
    assert rake["beadOffsets_m"][-1] == pytest.approx(2.1)
    assert rake["transform"]["position_m"] == pytest.approx([0.0, -0.1, 0.2])


def test_rake_grouping_can_be_turned_off():
    result = fds.load(SAMPLE, fds.ImportOptions(group_rakes=False))
    assert result.counts["thermocouple"] == 44


def test_a_wall_temperature_stays_distinct_from_a_gas_temperature(sample):
    # Both sit at the same 22 points in this file. They are different instruments and
    # the plan says which is which rather than merging them.
    surface, gas = by_id(sample, "tc-c1-c22"), by_id(sample, "tc-tc1-tc22")
    assert surface["mount"]["type"] == "wall"
    assert gas["mount"]["type"] == "pole"
    assert "surface temperature" in surface["notes"]


def test_ior_becomes_the_gauge_normal(sample):
    # IOR=2 means the device sits on a surface facing +Y, which is this format's
    # outward normal for a gauge -- and the fire is on the +Y side of it.
    gauge = by_id(sample, "hf-hf-1")
    position = gauge["transform"]["position_m"]
    target = gauge["transform"]["aimTarget_m"]
    assert target[1] > position[1]
    assert target[0] == pytest.approx(position[0])
    assert target[2] == pytest.approx(position[2])


def test_a_gauge_arrives_without_an_invented_range(sample):
    # FDS reports a flux at a point; it has no gauge and no full scale. Making one up
    # would turn every over-range and low-signal verdict in the plan into fiction.
    assert by_id(sample, "hf-hf-1")["gauge"]["range_kw_m2"] is None
    assert any(i.code == "fds-gauge-range" for i in sample.issues)


def test_quantities_with_no_counterpart_are_reported_not_imported():
    text = ("&DEVC ID='v', QUANTITY='VELOCITY', XYZ=1,1,1 /\n"
            "&DEVC ID='t', QUANTITY='THERMOCOUPLE', XYZ=1,1,1 /\n")
    result = fds.to_plan(text)
    assert result.counts.get("thermocouple") == 1
    velocity = next(g for g in result.devices if g.quantity == "VELOCITY")
    assert velocity.mapped_to is None and velocity.count == 1


def test_the_device_map_can_be_overridden():
    text = "&DEVC ID='t', QUANTITY='THERMOCOUPLE', XYZ=1,1,1 /\n"
    result = fds.to_plan(text, options=fds.ImportOptions(
        device_map={"THERMOCOUPLE": None}))
    assert "thermocouple" not in result.counts


# -- what the import tells you --------------------------------------------

def test_several_heat_release_surfaces_are_reported_and_the_choice_is_overridable(sample):
    assert sample.burner_surf == "FIRE"
    assert sample.burner_candidates == ["FIRE", "UPHOLSTERY"]
    assert any(i.code == "fds-fire-choice" for i in sample.issues)

    other = fds.load(SAMPLE, fds.ImportOptions(burner_surf="UPHOLSTERY"))
    assert other.burner_surf == "UPHOLSTERY"


def test_simulation_only_records_are_named_rather_than_silently_dropped(sample):
    skipped = next(i for i in sample.issues if i.code == "fds-not-imported")
    for group in ("&MESH", "&MATL", "&SLCF", "&BNDF"):
        assert group in skipped.message


def test_a_file_with_no_fire_still_converts_and_says_so():
    result = fds.to_plan("&MESH IJK=10,10,10, XB=0,1,0,1,0,1 /\n"
                         "&OBST XB=0,1,0,0.1,0,1 /\n")
    assert any(i.code == "fds-no-fire" for i in result.issues)
    assert result.counts.get("wall") == 1
    result.plan.validate_schema()


def test_text_that_is_not_fds_input_is_refused():
    with pytest.raises(Exception):
        fds.to_plan("{\"format\": \"fire-test-plan\"}")


# -- the golden fixture ----------------------------------------------------

def test_the_import_reproduces_the_committed_fixture_byte_for_byte(sample):
    # The fixture is the readable form of the mapping and the reference the
    # TypeScript importer is held against. Rebuild it with
    # `python tools/build_fixtures.py` when a rule deliberately changes.
    sample.plan.meta["created"] = "2026-08-15T00:00:00Z"
    sample.plan.meta["modified"] = "2026-08-15T00:00:00Z"
    with open(GOLDEN, encoding="utf-8") as fh:
        assert sample.plan.dumps() == fh.read()


def test_the_fixture_still_loads_as_a_plan():
    plan = Plan.load(GOLDEN)
    plan.validate_schema()
    assert plan.meta["source"]["tool"] == "FDS"
    assert plan.burner.hrr_kw == pytest.approx(300.0)


def test_from_fds_is_the_one_liner_for_a_notebook():
    plan = Plan.from_fds(SAMPLE)
    assert plan.meta["testId"] == "IR401_0"
    assert len(plan.walls) == 4


def test_the_source_offset_puts_a_plan_coordinate_back_into_fds_coordinates():
    plan = Plan.from_fds(SAMPLE)
    offset = plan.meta["source"]["originOffset_m"]
    wall = next(w for w in plan.walls if w.id == "wall-1")
    fds_y = wall.polyline_m[0][1] + offset[1]
    assert fds_y == pytest.approx(3.65)      # the &OBST centreline, y = (3.60+3.70)/2
