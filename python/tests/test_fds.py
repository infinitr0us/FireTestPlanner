"""Reading FDS input, and turning it into a plan.

Two layers, tested separately because they fail differently. The namelist reader
either understands the file's syntax or silently loses parameters -- and losing one
looks exactly like the file not having it. The mapping either puts geometry where
the file put it or moves the whole model, and an origin that is 100 mm out is
invisible in a screenshot and wrong in every dimension on the drawing.

The sample input in `fixtures/fds/` is a public ISO 9705-style room-corner case
written for this repository. It exercises the syntax traps and also generates the
real simulation output used by the results workspace.
"""

from __future__ import annotations

import json
import os

import pytest

from fireplan import Plan, fds, namelist
from fireplan.namelist import NamelistError

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SAMPLE = os.path.join(ROOT, "fixtures", "fds", "room_corner.fds")
GOLDEN = os.path.join(ROOT, "fixtures", "fds", "room_corner.ftp.json")


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
    # The sample's own &HEAD title contains "Public room corner / shortened two-stage propane fire". A reader that
    # stops at the first slash truncates the first record in the file and loses
    # every parameter after it.
    text = "&HEAD CHID='x', TITLE='Public / room' /\n&TIME T_END=60. /"
    records = namelist.read(text)
    assert [r.group for r in records] == ["HEAD", "TIME"]
    assert records[0].string("TITLE") == "Public / room"
    assert records[1].number("T_END") == 60.0


def test_parameters_separate_on_whitespace_as_well_as_commas():
    # The sample's &SURF, &MATL and &PROP records use newlines and no commas, so a
    # comma-splitter reads the whole body as one value of the first parameter.
    text = "&SURF ID = 'FIRE'\n      COLOR = 'RED'\n      HRRPUA = 9259.25925925926 /"
    rec = namelist.read(text)[0]
    assert rec.string("ID") == "FIRE"
    assert rec.string("COLOR") == "RED"
    assert rec.number("HRRPUA") == 9259.25925925926


def test_a_line_without_an_ampersand_is_a_comment():
    # This is how an FDS line gets disabled, and the sample does exactly this to a
    # REAC carrying RADIATIVE_FRACTION=0.32. Reading it would change every predicted
    # heat flux in the plan.
    text = "REAC FUEL='METHANE', RADIATIVE_FRACTION=0.32 /\n&REAC FUEL='PROPANE' /"
    records = namelist.read(text)
    assert len(records) == 1
    assert records[0].string("FUEL") == "PROPANE"
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


def test_a_bang_comment_is_not_live_input():
    """`!` is the Fortran namelist comment, and FDS reads these records with
    Fortran's own namelist READ. Real inputs are full of disabled `! &OBST` lines,
    and reading one back as live input puts a record into the model that the
    simulation never had."""
    records = namelist.read(
        "! Example only: &REAC RADIATIVE_FRACTION=0.9 /\n"
        "&REAC FUEL='PROPANE', RADIATIVE_FRACTION=0.3 /\n")
    assert [r.group for r in records] == ["REAC"]
    assert records[0].number("RADIATIVE_FRACTION") == 0.3

    # ...and inline, where it disables the rest of one line only.
    rec = namelist.read("&OBST XB=0,1,0,1,0,1 ! and /tmp, which is not the end\n"
                        "      SURF_ID='W' /")[0]
    assert rec.numbers("XB") == [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
    assert rec.string("SURF_ID") == "W"


def test_a_bang_inside_a_string_is_not_a_comment():
    assert namelist.read("&HEAD TITLE='Bob''s ! test' /")[0].string("TITLE") == "Bob's ! test"


def test_an_ampersand_in_prose_does_not_swallow_the_next_record():
    """A record opens only where a line does.

    Searching the text for the next `&` does worse than read prose as input: `R&D`
    starts a `&D` record whose body runs to the next `/`, and the real record in
    between disappears with no trace at all.
    """
    records = namelist.read(
        "&HEAD CHID='t' /\n"
        "R&D department reference note\n"
        "&OBST XB=0,1,0,1,0,1 /\n"
        "&TAIL /\n")
    assert [r.group for r in records] == ["HEAD", "OBST", "TAIL"]
    assert records[1].line == 3


def test_a_second_record_after_a_slash_on_one_line_is_still_read():
    assert [r.group for r in namelist.read("&OBST XB=1,2,3,4,5,6 / &VENT XB=1,2,3,4,5,5 /")] \
        == ["OBST", "VENT"]


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
        "wall": 4, "ceiling": 1, "burner": 1, "heatFluxSensor": 13, "thermocouple": 4,
    }
    assert not sample.errors


def test_the_origin_lands_on_the_burner_centre_at_floor_level(sample):
    # The 0.18 m burner is centred at (1.11, 2.11); the slab top is z=0.5.
    # Subtract all three components to place its base at the plan origin.
    assert sample.origin_m == pytest.approx((1.11, 2.11, 0.5))
    burner = one(sample, "burner")
    assert burner["transform"]["position_m"] == pytest.approx([0.0, 0.0, 0.0])
    assert sample.plan.meta["source"]["originOffset_m"] == pytest.approx([1.11, 2.11, 0.5])


def test_the_floor_is_the_slab_top_not_the_bottom_of_the_mesh(sample):
    # The meshes start at z = 0.3 and the floor slab's top is z = 0.5. Taking the mesh
    # would put every height in the plan 200 mm out and leave the burner floating.
    assert sample.origin_m[2] == 0.5
    assert one(sample, "ceiling")["height_m"] == pytest.approx(2.4)


def test_hrr_comes_from_hrrpua_times_area_times_the_ramp_peak(sample):
    # SURF 'FIRE' is 9259.25925925926 kW/m2 on 0.18 x 0.18 m; 'burner_steps' peaks
    # at F = 1.0, so 300 kW.
    burner = one(sample, "burner")
    assert burner["fire"]["hrr_kw"] == pytest.approx(300.0)
    assert burner["footprint"] == {"shape": "square", "size_m": pytest.approx([0.18, 0.18])}
    assert burner["rimHeight_m"] == pytest.approx(0.3)
    assert burner["fire"]["fuel"] == "propane"


def test_a_ramp_that_never_reaches_one_scales_the_heat_release():
    text = ("&SURF ID='B', HRRPUA=1000., RAMP_Q='r' /\n"
            "&RAMP ID='r', T=0., F=0. /\n&RAMP ID='r', T=60., F=0.4 /\n"
            "&OBST XB=0,1,0,1,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
            "&SURF ID='I' /\n")
    result = fds.to_plan(text)
    burner = one(result, "burner")
    assert burner["fire"]["hrr_kw"] == pytest.approx(1000.0 * 1.0 * 0.4)


def test_a_long_simulation_time_is_spelled_the_way_javascript_spells_it():
    # This string ends up in meta.notes, so the two importers have to agree on it.
    # Python's "{:g}" goes exponential at 1e6 and JavaScript does not, which would
    # have written "1e+06 s" here and "1000000 s" in the editor.
    text = "&TIME T_END=1000000. /\n&OBST XB=0,1,0,0.1,0,2 /\n"
    assert "T_END 1000000 s" in fds.to_plan(text).plan.meta["notes"]


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
    # Front wall: XB=0.9,3.5,5.6,5.7,0.4,3.0. Its centreline y=5.65
    # becomes 3.54 after subtracting the burner-centre offset.
    wall = by_id(sample, "wall-1")
    assert [c for point in wall["polyline_m"] for c in point] == pytest.approx(
        [-0.21, 3.54, 2.39, 3.54])
    assert wall["thickness_m"] == pytest.approx(0.1)
    assert wall["baseHeight_m"] == pytest.approx(0.0)


def test_a_wall_buried_below_the_floor_keeps_its_top_where_the_file_put_it(sample):
    # Every wall in the sample starts at z = 0.4, 100 mm into the slab. Clamping the
    # base without shortening the wall would put its top 2.6 m above the floor
    # instead of the 2.5 m (FDS Z=3.0) the file asks for.
    assert by_id(sample, "wall-1")["height_m"] == pytest.approx(2.5)


def test_the_floor_slab_is_not_imported_as_an_object(sample):
    # The floor is the z = 0 plane in this format, not a ceiling at height 0.
    ceilings = [o for o in sample.plan.data["objects"] if o["type"] == "ceiling"]
    assert [c["height_m"] for c in ceilings] == [pytest.approx(2.4)]


def test_a_hole_becomes_an_opening_positioned_along_the_wall(sample):
    # HOLE X=1.8..2.6, Z=0.5..2.5 cuts the wall starting at X=0.9.
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
    assert "LINING" in by_id(sample, "wall-2")["notes"]


# -- devices ---------------------------------------------------------------

def test_a_thermocouples_quantity_is_found_through_its_prop(sample):
    # &DEVC PROP_ID='BEAD' carries no QUANTITY of its own. Every thermocouple in the
    # sample is written this way, so a reader that only looks at QUANTITY imports none.
    rake = by_id(sample, "tc-back-tc-1-back-tc-6")
    assert rake["thermocouple"]["beadDiameter_mm"] == pytest.approx(1.5)


def test_a_vertical_run_of_devices_becomes_one_rake(sample):
    rake = by_id(sample, "tc-back-tc-1-back-tc-6")
    assert len(rake["beadOffsets_m"]) == 6
    assert rake["beadOffsets_m"][0] == 0.0
    assert rake["beadOffsets_m"][-1] == pytest.approx(2.0)
    assert rake["transform"]["position_m"] == pytest.approx([0.04, -0.109, 0.35])


def test_rake_grouping_can_be_turned_off():
    result = fds.load(SAMPLE, fds.ImportOptions(group_rakes=False))
    assert result.counts["thermocouple"] == 24


def test_a_wall_temperature_stays_distinct_from_a_gas_temperature(sample):
    # Both sit at the same 12 points in this file. They are different instruments and
    # the plan says which is which rather than merging them.
    surface, gas = by_id(sample, "tc-back-wt-1-back-wt-6"), by_id(sample, "tc-back-tc-1-back-tc-6")
    assert surface["mount"]["type"] == "wall"
    assert gas["mount"]["type"] == "pole"
    assert "surface temperature" in surface["notes"]


def test_ior_becomes_the_gauge_normal(sample):
    # IOR=2 means the device sits on a surface facing +Y, which is this format's
    # outward normal for a gauge -- and the fire is on the +Y side of it.
    gauge = by_id(sample, "hf-back-hf-1")
    position = gauge["transform"]["position_m"]
    target = gauge["transform"]["aimTarget_m"]
    assert target[1] > position[1]
    assert target[0] == pytest.approx(position[0])
    assert target[2] == pytest.approx(position[2])


def test_a_gauge_arrives_without_an_invented_range(sample):
    # FDS reports a flux at a point; it has no gauge and no full scale. Making one up
    # would turn every over-range and low-signal verdict in the plan into fiction.
    assert by_id(sample, "hf-back-hf-1")["gauge"]["range_kw_m2"] is None
    assert any(i.code == "fds-gauge-range" for i in sample.issues)


def test_quantities_with_no_counterpart_are_reported_not_imported():
    text = ("&DEVC ID='v', QUANTITY='VELOCITY', XYZ=1,1,1 /\n"
            "&DEVC ID='t', QUANTITY='THERMOCOUPLE', XYZ=1,1,1 /\n")
    result = fds.to_plan(text)
    assert result.counts.get("thermocouple") == 1
    velocity = next(g for g in result.devices if g.quantity == "VELOCITY")
    assert velocity.mapped_to is None and velocity.count == 1


def test_skipping_geometry_does_not_move_the_instruments(sample):
    """`geometry=False` means "do not emit walls", not "do not read them".

    The obstructions are what locate the fire and the floor, and therefore the
    origin. A reader that skips them entirely still finds the burner but loses the
    floor, and every instrument in the plan lands at the wrong height.
    """
    devices_only = fds.load(SAMPLE, fds.ImportOptions(geometry=False))
    assert devices_only.origin_m == pytest.approx(sample.origin_m)
    assert "wall" not in devices_only.counts
    assert devices_only.counts["heatFluxSensor"] == 13

    gauge = next(o for o in devices_only.plan.data["objects"] if o["id"] == "hf-back-hf-1")
    reference = by_id(sample, "hf-back-hf-1")
    assert gauge["transform"]["position_m"] == pytest.approx(
        reference["transform"]["position_m"])


def test_the_device_map_can_be_overridden():
    text = "&DEVC ID='t', QUANTITY='THERMOCOUPLE', XYZ=1,1,1 /\n"
    result = fds.to_plan(text, options=fds.ImportOptions(
        device_map={"THERMOCOUPLE": None}))
    assert "thermocouple" not in result.counts


# -- what the import tells you --------------------------------------------

def test_a_lining_that_burns_is_reported_but_is_not_offered_as_a_burner(sample):
    """The sample's 'LINING' burns on two wall faces and the ceiling soffit.

    None of those is a floor-standing source, so the only candidate is the ignition
    pan -- and the lining is named in the report rather than passed over. Offering
    it as a burner would produce a 2.6 x 3.8 m pan with a 2.4 m rim: a solid box the size
    of the room, reaching from the floor to the ceiling.
    """
    assert sample.burner_surf == "FIRE"
    assert sample.burner_candidates == ["FIRE"]
    lining = [i for i in sample.issues if i.code == "fds-fire-not-a-burner"]
    assert len(lining) == 1 and "LINING" in lining[0].message

    # Asking for it anyway falls back to the pan, and says so rather than quietly
    # describing a fire somewhere else.
    other = fds.load(SAMPLE, fds.ImportOptions(burner_surf="LINING"))
    assert other.burner_surf == "FIRE"
    assert any(i.code == "fds-burner-unavailable" for i in other.issues)
    other.plan.validate_schema()


def test_a_ceiling_soffit_fire_does_not_become_a_room_sized_burner():
    """A downward-facing fire face has a footprint, which is what makes it
    dangerous: taken as a burner, its rim height is the height of the ceiling."""
    result = fds.to_plan(
        "&SURF ID='L' HRRPUA=300. /\n"
        "&OBST ID='floor' XB=0,3,0,4,-0.1,0.0 /\n"
        "&OBST ID='slab' XB=0,3,0,4,2.4,2.5, "
        "SURF_ID6='I','I','I','I','L','I' /\n")
    assert result.burner_candidates == []
    assert result.counts.get("burner", 0) == 0
    assert any(i.code == "fds-fire-not-a-burner" for i in result.issues)
    # ...and the slab is still the ceiling it always was.
    assert one(result, "ceiling")["height_m"] == pytest.approx(2.4)


def test_the_burner_choice_is_overridable_between_real_pans():
    two_pans = (
        "&MESH IJK=40,40,30, XB=-1,5,-1,5,0,3 /\n"
        "&SURF ID='SMALL' HRRPUA=500. /\n"
        "&SURF ID='BIG' HRRPUA=100. /\n"
        "&VENT XB=0,0.5,0,0.5,0.5,0.5, SURF_ID='SMALL' /\n"
        "&VENT XB=2,4,2,4,0.5,0.5, SURF_ID='BIG' /\n")
    result = fds.to_plan(two_pans)
    assert result.burner_candidates == ["BIG", "SMALL"]
    assert result.burner_surf == "SMALL"            # the most compact one
    assert any(i.code == "fds-fire-choice" for i in result.issues)

    assert fds.to_plan(two_pans, options=fds.ImportOptions(burner_surf="BIG")).burner_surf == "BIG"


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


def test_a_burner_vent_flush_with_the_mesh_boundary_is_not_a_boundary_condition():
    """A floor fire in a domain that starts at the floor is written flush with a
    domain face. Dropping it as an OPEN-style boundary vent left the plan with no
    fire, an origin fallen back to the mesh centre, and a warning telling the user
    their own input has no heat source."""
    result = fds.to_plan(
        "&MESH IJK=40,40,30, XB=0,4,0,4,0,3 /\n"
        "&SURF ID='B' HRRPUA=100. /\n"
        "&VENT XB=0,1,0,1,0,0, SURF_ID='B' /\n")
    burner = one(result, "burner")
    assert burner["fire"]["hrr_kw"] == pytest.approx(100.0)
    assert result.origin_m[:2] == (0.5, 0.5)
    assert "fds-no-fire" not in [i.code for i in result.issues]


def test_every_face_of_the_chosen_surface_becomes_a_burner():
    """One &SURF over several &VENTs is two burners in a room, not one. The second
    fire location used to vanish while the conversion reported success."""
    result = fds.to_plan(
        "&MESH IJK=40,40,30, XB=-1,5,-1,5,0,3 /\n"
        "&SURF ID='B' HRRPUA=100. /\n"
        "&VENT XB=0,1,0,1,0.5,0.5, SURF_ID='B' /\n"
        "&VENT XB=3,4,3,4,0.5,0.5, SURF_ID='B' /\n")
    burners = [o for o in result.plan.data["objects"] if o["type"] == "burner"]
    assert len(burners) == 2
    assert "fds-burner-instances" in [i.code for i in result.issues]
    # The primary is the one the frame was built around, so it is at the origin.
    assert result.plan.burner.position[0] == pytest.approx(0.0)
    assert result.plan.burner.position[1] == pytest.approx(0.0)


def test_a_wall_fire_is_reported_rather_than_flattened_into_a_zero_area_burner():
    """A vertical heat-release face has no plan footprint. Writing one out as
    `size_m: [1.0, 0.0]` produced a plan that saved and then would not reopen."""
    result = fds.to_plan(
        "&MESH IJK=40,40,30, XB=-1,5,-1,5,0,3 /\n"
        "&SURF ID='B' HRRPUA=100. /\n"
        "&VENT XB=1,2,1,1,0,2, SURF_ID='B' /\n")
    assert result.counts.get("burner", 0) == 0
    assert "fds-fire-not-a-burner" in [i.code for i in result.issues]
    result.plan.validate_schema()


def test_an_overhead_slab_is_never_taken_as_the_floor_when_the_fire_is_below_it():
    """A floor-level fire under a ceiling, with no floor slab drawn.

    The fallback to "any slab" chose the ceiling: origin at its top, the ceiling
    itself dropped as floor geometry, and a device at 1 m placed at -2.1 m.
    """
    result = fds.to_plan(
        "&HEAD CHID='review-floor' /\n&MESH XB=0,4,0,4,0,4 /\n"
        "&SURF ID='B', HRRPUA=100 /\n&VENT XB=0,1,0,1,0,0, SURF_ID='B' /\n"
        "&OBST XB=0,4,0,4,3,3.1 /\n"
        "&DEVC XYZ=1,1,1, QUANTITY='TEMPERATURE' /\n&TAIL /\n")
    assert result.origin_m == pytest.approx((0.5, 0.5, 0.0))
    assert one(result, "ceiling")["height_m"] == pytest.approx(3.0)
    assert one(result, "thermocouple")["transform"]["position_m"][2] == pytest.approx(1.0)
    note = next(i for i in result.issues if i.code == "fds-floor-inferred")
    assert "kept as ceilings" in note.message


@pytest.mark.parametrize("ior", [", IOR=-3", ""])
def test_a_downward_facing_vent_is_a_soffit_fire_not_an_upward_pan(ior):
    """Every horizontal vent used to be +z. One on the underside of a ceiling --
    stated by IOR=-3, or established by the slab it sits under -- became a square
    burner with a 3 m rim: an upward flame on a three-metre-high pan."""
    text = ("&HEAD CHID='downward' /\n&MESH XB=0,4,0,4,0,4 /\n"
            "&OBST XB=0,4,0,4,-0.1,0 /\n&OBST XB=0,4,0,4,3,3.1 /\n"
            "&SURF ID='B', HRRPUA=100 /\n"
            "&VENT XB=1,2,1,2,3,3, SURF_ID='B'{} /\n&TAIL /\n".format(ior))
    result = fds.to_plan(text)
    assert result.counts.get("burner", 0) == 0
    assert "fds-fire-not-a-burner" in [i.code for i in result.issues]
    assert one(result, "ceiling")["height_m"] == pytest.approx(3.0)
    result.plan.validate_schema()

    # The same footprint on the TOP of the floor slab, with nothing stated, is the
    # ordinary burner -- and an explicit IOR wins over inspection either way.
    plain = text.replace("SURF_ID='B'" + ior + " /", "SURF_ID='B' /")
    assert fds.to_plan(plain.replace("XB=1,2,1,2,3,3", "XB=1,2,1,2,0,0")).counts["burner"] == 1
    assert fds.to_plan(plain.replace("SURF_ID='B' /", "SURF_ID='B', IOR=3 /")).counts["burner"] == 1


def test_a_zero_thickness_obstruction_is_given_a_drawable_thickness():
    """FDS thin obstructions -- glazing, partitions -- are ordinary. A wall of
    thickness zero and a slab of thickness zero were both objects the schema
    rejects, which blocked the whole import."""
    result = fds.to_plan(
        "&SURF ID='B' HRRPUA=100. /\n"
        "&OBST ID='floor' XB=-1,5,-1,5,-0.1,0 /\n"
        "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
        "&OBST ID='glazing' XB=0,2,1,1,0,2.4 /\n"
        "&OBST ID='shelf' XB=2,3,2,3,1.2,1.2 /\n")
    assert by_id(result, "wall-glazing")["thickness_m"] == fds.THIN_M
    shelf = by_id(result, "ceiling-shelf")
    assert shelf["thickness_m"] == fds.THIN_M
    assert shelf["height_m"] == pytest.approx(1.2)
    result.plan.validate_schema()
    note = next(i for i in result.issues if i.code == "fds-thin-geometry")
    assert "2 zero-thickness" in note.message


def test_a_ramp_that_never_leaves_zero_is_a_surface_switched_off():
    """`peak or 1` read "no ramp" and "a peak of zero" as the same thing, and turned
    a burner the input switches off into the largest fire in the file."""
    result = fds.to_plan(
        "&SURF ID='B' HRRPUA=100. RAMP_Q='r' /\n"
        "&RAMP ID='r' T=0. F=0.0 /\n"
        "&RAMP ID='r' T=10. F=0.0 /\n"
        "&VENT XB=0,1,0,1,0.5,0.5, SURF_ID='B' /\n")
    assert result.counts.get("burner", 0) == 0
    assert "fds-surface-off" in [i.code for i in result.issues]


# -- geometry that is not a ceiling ----------------------------------------

def test_a_tiled_floor_is_all_floor_rather_than_one_tile_and_some_ceilings():
    """A meshed model tiles its floor, one &OBST per mesh. Skipping only the lowest
    left the rest to be converted as slabs at floor level -- ceilings with a
    negative height, which no schema version accepts."""
    result = fds.to_plan(
        "&MESH IJK=40,40,30, XB=-1,5,-1,5,-1,3 /\n"
        "&SURF ID='B' HRRPUA=100. /\n"
        "&OBST ID='floor-a' XB=0,2,0,4,-0.1,0.0 /\n"
        "&OBST ID='floor-b' XB=2,4,0,4,-0.1,0.0 /\n"
        "&VENT XB=1,2,1,2,0.0,0.0, SURF_ID='B' /\n")
    assert result.counts.get("ceiling", 0) == 0
    result.plan.validate_schema()


def test_a_slab_resting_on_the_floor_is_a_box_not_a_ceiling():
    # A plinth's soffit height is zero, which is not a ceiling and not a valid one.
    result = fds.to_plan(
        "&SURF ID='B' HRRPUA=500. /\n"
        "&OBST ID='floor' XB=-1,5,-1,5,-0.1,0.0 /\n"
        "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
        "&OBST ID='plinth' XB=1,3,1,3,0,0.15 /\n")
    assert result.counts.get("ceiling", 0) == 0
    assert one(result, "obstruction")["name"] == "plinth"
    result.plan.validate_schema()


# -- &MULT -----------------------------------------------------------------

def test_a_mult_on_a_mesh_moves_the_domain_and_therefore_the_origin():
    """With no burner the origin is the centre of the domain, so a MULT_ID this
    reader ignored shifted every imported coordinate by a mesh width."""
    result = fds.to_plan(
        "&MULT ID='m' DX=10, I_UPPER=1 /\n"
        "&MESH IJK=10,10,10, XB=0,10,0,4,0,3, MULT_ID='m' /\n"
        "&DEVC ID='tc', QUANTITY='THERMOCOUPLE', XYZ=15,2,1 /\n")
    assert result.origin_m[0] == pytest.approx(10.0)
    assert one(result, "thermocouple")["transform"]["position_m"][0] == pytest.approx(5.0)


def test_a_mult_skip_range_leaves_a_hole_rather_than_filling_it():
    result = fds.to_plan(
        "&MULT ID='row', DX=1.0, I_LOWER=0, I_UPPER=3, I_LOWER_SKIP=1, I_UPPER_SKIP=2 /\n"
        "&OBST XB=0,0.2,0,0.2,0,1.0, MULT_ID='row', ID='post' /\n")
    posts = [o for o in result.plan.data["objects"] if o["type"] == "obstruction"]
    assert len(posts) == 2
    xs = sorted(o["transform"]["position_m"][0] for o in posts)
    assert xs[1] - xs[0] == pytest.approx(3.0)


# -- malformed input, and the paste box ------------------------------------

def test_a_truncated_xb_is_skipped_rather_than_raising():
    """`&OBST XB=0,1,2 /` is a half-finished hand edit. Indexing six values before
    checking there are six ended a whole import with an IndexError."""
    result = fds.to_plan("&HEAD CHID='t' /\n&OBST XB=0,1,2 /\n&TAIL /\n")
    assert result.counts == {}
    assert fds.to_plan("&MESH XB=0,1,2 /\n&HEAD CHID='t' /\n") is not None


@pytest.mark.parametrize("text", [
    "&MESH IJK=10,10,10, XB=0,1,0,1,0,1 /",
    "&INIT XB=0,1,0,1,0,1, TEMPERATURE=100. /",
])
def test_only_obst_and_vent_paste_as_geometry(text):
    # Every one of these carries an XB, and none of them is a wall.
    assert fds.obstruction_from_record(namelist.read_one(text)) is None


def test_a_vent_does_not_paste_as_geometry():
    # A planar vent pasted as geometry became a box with a zero extent: it saved,
    # and the editor then refused to reopen the file. A vent is a face on a solid.
    assert fds.obstruction_from_record(namelist.read_one("&VENT XB=0,1,0,1,0,0 /")) is None
    plate = fds.obstruction_from_record(namelist.read_one("&OBST XB=0,2,1,1,0,2.4 /"))
    assert plate["type"] == "wall" and plate["thickness_m"] == fds.THIN_M


def test_only_devc_pastes_as_an_instrument():
    slice_file = namelist.read_one("&SLCF QUANTITY='TEMPERATURE', XYZ=1,1,1 /")
    assert fds.device_from_record(slice_file) is None
    device = namelist.read_one("&DEVC QUANTITY='TEMPERATURE', XYZ=1,1,1 /")
    assert fds.device_from_record(device)["type"] == "thermocouple"


# -- &CATF -----------------------------------------------------------------

def _split_case(tmp_path):
    root = tmp_path / "root.fds"
    root.write_text(
        "&HEAD CHID='root' /\n"
        "&MESH IJK=10,10,10, XB=0,4,0,4,0,3 /\n"
        "&CATF OTHER_FILES='child.fds' /\n"
        "&TAIL /\n", encoding="utf-8")
    (tmp_path / "child.fds").write_text(
        "&SURF ID='B' HRRPUA=100. /\n"
        "&VENT XB=1,2,1,2,0.5,0.5, SURF_ID='B' /\n", encoding="utf-8")
    return root


def test_a_catf_include_is_spliced_where_it_sits_not_after_tail(tmp_path):
    """&CATF belongs in the body, before &TAIL -- that is where the official
    validation cases put it -- and reading stops at &TAIL. A child appended after
    the parent's last line is a child nobody reads."""
    result = fds.load(str(_split_case(tmp_path)))
    assert one(result, "burner")["fire"]["hrr_kw"] == pytest.approx(100.0)


def test_a_child_s_tail_ends_the_child_not_the_model(tmp_path):
    """FDS copies an included file up to its &TAIL (COPY_FILE_TO_CAT, read.f90) and
    then carries on with the parent after the &CATF line. The parent's thermocouple
    is in the model; the child's record after its &TAIL is not, and that is said."""
    root = tmp_path / "root.fds"
    root.write_text("&HEAD CHID='catf' /\n&CATF OTHER_FILES='child.fds' /\n"
                    "&DEVC ID='parent', XYZ=1,1,1, QUANTITY='TEMPERATURE' /\n&TAIL /\n",
                    encoding="utf-8")
    (tmp_path / "child.fds").write_text(
        "&HEAD CHID='child' /\n&OBST XB=0,2,0,0.1,0,2 /\n&TAIL /\n&OBST XB=3,5,0,0.1,0,2 /\n",
        encoding="utf-8")
    result = fds.load(str(root))
    tail = next(i for i in result.issues if i.code == "fds-catf-tail")
    assert "child.fds" in tail.message and tail.severity == "info"
    assert result.counts.get("wall") == 1
    assert result.counts.get("thermocouple") == 1
    assert result.plan.title == "catf"          # the child's &HEAD is not copied


def test_nested_includes_are_not_followed_as_fds_does_not(tmp_path):
    """FDS stops copying a child at its own &CATF line and never reads a grandchild."""
    (tmp_path / "grand.fds").write_text("&OBST XB=3,5,0,0.1,0,2 /\n", encoding="utf-8")
    (tmp_path / "child.fds").write_text(
        "&OBST XB=0,2,0,0.1,0,2 /\n&CATF OTHER_FILES='grand.fds' /\n&OBST XB=0,0.1,0,2,0,2 /\n",
        encoding="utf-8")
    root = tmp_path / "root.fds"
    root.write_text("&HEAD CHID='r' /\n&CATF OTHER_FILES='child.fds' /\n&TAIL /\n",
                    encoding="utf-8")
    result = fds.load(str(root))
    assert result.counts.get("wall") == 1
    assert "fds-catf-nested" in [i.code for i in result.issues]


def test_an_input_including_itself_is_not_spliced_twice(tmp_path):
    root = tmp_path / "root.fds"
    root.write_text("&HEAD CHID='r' /\n&OBST XB=0,2,0,0.1,0,2 /\n"
                    "&CATF OTHER_FILES='root.fds' /\n&TAIL /\n", encoding="utf-8")
    result = fds.load(str(root))
    assert result.counts.get("wall") == 1
    assert "fds-catf-cycle" in [i.code for i in result.issues]


def test_a_missing_input_raises_its_own_error(tmp_path):
    with pytest.raises(OSError):
        fds.load(str(tmp_path / "no-such-model.fds"))


def test_converting_bare_text_says_its_includes_went_unread(tmp_path):
    # The browser is handed one file's bytes and cannot go looking. Silence there
    # would present a fraction of a model as a whole one.
    text = _split_case(tmp_path).read_text(encoding="utf-8")
    result = fds.to_plan(text, "root.fds")
    assert "fds-catf-unresolved" in [i.code for i in result.issues]


def test_an_unreadable_include_is_reported_rather_than_thrown(tmp_path):
    (tmp_path / "sub").mkdir()
    root = tmp_path / "root.fds"
    root.write_text("&HEAD CHID='r' /\n&CATF OTHER_FILES='sub' /\n&TAIL /\n", encoding="utf-8")
    result = fds.load(str(root))
    assert "fds-catf-unreadable" in [i.code for i in result.issues]


def test_a_file_included_twice_is_not_reported_as_including_itself(tmp_path):
    (tmp_path / "common.fds").write_text("&SURF ID='C' /\n", encoding="utf-8")
    root = tmp_path / "root.fds"
    root.write_text("&HEAD CHID='r' /\n&CATF OTHER_FILES='common.fds','common.fds' /\n&TAIL /\n",
                    encoding="utf-8")
    codes = [i.code for i in fds.load(str(root)).issues]
    assert "fds-catf-cycle" not in codes
    assert "fds-catf-repeat" in codes


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
    assert plan.meta["testId"] == "room_corner"
    assert len(plan.walls) == 4


def test_the_source_offset_puts_a_plan_coordinate_back_into_fds_coordinates():
    plan = Plan.from_fds(SAMPLE)
    offset = plan.meta["source"]["originOffset_m"]
    wall = next(w for w in plan.walls if w.id == "wall-1")
    fds_y = wall.polyline_m[0][1] + offset[1]
    assert fds_y == pytest.approx(5.65)      # the &OBST centreline, y = (5.6+5.7)/2


# -- review 2026-09-22: shared cases, run by web/src/core/fds.test.ts too --

_REVIEW_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                           "fixtures", "fds")
with open(os.path.join(_REVIEW_DIR, "review-cases.json"), encoding="utf-8") as _fh:
    _REVIEW_CASES = json.load(_fh)
with open(os.path.join(_REVIEW_DIR, "review-cases.golden.json"), encoding="utf-8") as _fh:
    _REVIEW_GOLDEN = json.load(_fh)


@pytest.mark.parametrize("case", _REVIEW_CASES, ids=[c["name"] for c in _REVIEW_CASES])
def test_review_case(case):
    result = fds.to_plan(case["text"], "case.fds", fds.ImportOptions(imported_at="2026-08-15T00:00:00Z"))
    assert result.counts == case["counts"]
    offset = result.plan.data["meta"]["source"]["originOffset_m"]
    if "originZ" in case:
        assert offset[2] == pytest.approx(case["originZ"])
    burners = [o for o in result.plan.data["objects"] if o["type"] == "burner"]
    if "burnerHrrKw" in case:
        if case["burnerHrrKw"] is None:
            assert burners[0]["fire"].get("hrr_kw") is None
        else:
            assert burners[0]["fire"]["hrr_kw"] == pytest.approx(case["burnerHrrKw"])
    if "burnerRimM" in case:
        assert burners[0]["rimHeight_m"] == pytest.approx(case["burnerRimM"])
    by_id = {o["id"]: o for o in result.plan.data["objects"]}
    for oid, xyz in case.get("sourceXyz", []):
        pos = by_id[oid]["transform"]["position_m"]
        assert [pos[k] + offset[k] for k in range(3)] == pytest.approx(xyz, abs=1e-6)
    codes = [i.code for i in result.issues]
    for code in case.get("codes", []):
        assert code in codes
    for code in case.get("absentCodes", []):
        assert code not in codes
    result.plan.meta["created"] = "2026-08-15T00:00:00Z"
    result.plan.meta["modified"] = "2026-08-15T00:00:00Z"
    assert result.plan.dumps() == _REVIEW_GOLDEN[case["name"]]


def test_repeated_quoted_strings_and_null_repeats_keep_their_places():
    """Mirrored in web/src/core/fds.test.ts (FDSI-15, FDSI-16)."""
    recs = namelist.read("&OBST SURF_ID6=2*'my surf','A' /\n&OBST SURF_ID6=2*,'A','B' /\n"
                         "&DEVC IOR=1D400 /")
    assert recs[0].strings("SURF_ID6") == ["my surf", "my surf", "A"]
    assert recs[1].strings("SURF_ID6") == [None, None, "A", "B"]
    assert recs[2].number("IOR") is None
