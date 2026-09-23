/**
 * Reading FDS input in the editor.
 *
 * The load-bearing test is the last one: this importer and `fireplan.fds` must turn
 * the sample input into the same plan, byte for byte. Two importers that agree about
 * the syntax but not about which box is a wall would hand a fire safety engineer and
 * a data scientist two different rooms from one file, which is the failure this whole
 * format exists to prevent.
 *
 * The sample in `fixtures/fds/` is a real case from a fire safety engineer, and it
 * exercises all three of the syntax traps in `namelist.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  deviceFromRecord,
  fdsToPlan,
  obstructionFromRecord,
  THIN_M,
  type FdsImportResult,
  type Xb,
} from './fds';
import {
  applyXbToObject,
  fdsFrame,
  xbOfObject,
  xbProblem,
  xyzOfObject,
} from './fdsview';
import { NamelistError, readNamelist, readOneRecord } from './namelist';
import { spliceFdsIncludes } from '../io/files';
import { rangeOf } from './math';
import { checkPlan, newPlan, primaryBurner } from './plan';
import { serializePlan } from './serialize';
import type { BurnerObject, CeilingObject, ObstructionObject, PlanObject, ThermocoupleObject, Vec3, WallObject } from './types';
import { requiredFormatVersion } from './types';
import { validateStructure } from './validate';

const SAMPLE_PATH = fileURLToPath(new URL('../../../fixtures/fds/IR401_0.fds', import.meta.url));
const SAMPLE_TEXT = readFileSync(SAMPLE_PATH, 'utf8');
const GOLDEN_PATH = fileURLToPath(new URL('../../../fixtures/fds/IR401_0.ftp.json', import.meta.url));
const GOLDEN_TEXT = readFileSync(GOLDEN_PATH, 'utf8');

const IMPORTED_AT = '2026-08-15T00:00:00Z';
const sample = (): FdsImportResult =>
  fdsToPlan(SAMPLE_TEXT, 'IR401_0.fds', { importedAt: IMPORTED_AT });

const byId = (result: FdsImportResult, id: string): PlanObject =>
  result.doc.objects.find((o) => o.id === id)!;

const only = (result: FdsImportResult, type: string): PlanObject => {
  const found = result.doc.objects.filter((o) => o.type === type);
  expect(found).toHaveLength(1);
  return found[0];
};

/**
 * Compare coordinates the way the file does: to 1 um.
 *
 * `3.65 - 0.1` is 3.5500000000000003 in IEEE double arithmetic and 3.55 on paper.
 * The writer rounds to 1 um before anything reaches disk, so exact equality here
 * would be testing floating point rather than the mapping.
 */
const near = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
};

const nearPairs = (
  actual: ReadonlyArray<readonly number[]>, expected: ReadonlyArray<readonly number[]>,
): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => near(point, expected[i]));
};

// -- the namelist reader --------------------------------------------------

describe('namelist reader', () => {
  it('does not end a record at a slash inside a quoted string', () => {
    // The sample's own &HEAD title contains "34.2x1000/300=114s". A reader that stops
    // at the first slash truncates the first record in the file.
    const records = readNamelist(
      "&HEAD CHID='x', TITLE='burnout=34.2/300=114s' /\n&TIME T_END=60. /");
    expect(records.map((r) => r.group)).toEqual(['HEAD', 'TIME']);
    expect(records[0].string('TITLE')).toBe('burnout=34.2/300=114s');
    expect(records[1].number('T_END')).toBe(60);
  });

  it('separates parameters on whitespace as well as commas', () => {
    // The sample's &SURF, &MATL and &PROP records use newlines and no commas.
    const rec = readNamelist("&SURF ID = 'FIRE'\n  COLOR = 'RED'\n  HRRPUA = 7500. /")[0];
    expect(rec.string('ID')).toBe('FIRE');
    expect(rec.string('COLOR')).toBe('RED');
    expect(rec.number('HRRPUA')).toBe(7500);
  });

  it('treats a line without a leading ampersand as a comment', () => {
    // This is how an FDS line gets disabled, and the sample does exactly this to a
    // REAC carrying RADIATIVE_FRACTION=0.29.
    const records = readNamelist(
      "REAC FUEL='PROPANE', RADIATIVE_FRACTION=0.29 /\n&REAC FUEL='POLYURETHANE' /");
    expect(records).toHaveLength(1);
    expect(records[0].string('FUEL')).toBe('POLYURETHANE');
    expect(records[0].number('RADIATIVE_FRACTION')).toBeNull();
  });

  it('does not read a ! comment as live input', () => {
    // `!` is the Fortran namelist comment, and FDS reads these records with
    // Fortran's own namelist READ. Real inputs are full of disabled `! &OBST` lines,
    // and reading one back puts a record into the model the simulation never had.
    const records = readNamelist(
      '! Example only: &REAC RADIATIVE_FRACTION=0.9 /\n'
      + "&REAC FUEL='PROPANE', RADIATIVE_FRACTION=0.3 /\n");
    expect(records.map((r) => r.group)).toEqual(['REAC']);
    expect(records[0].number('RADIATIVE_FRACTION')).toBe(0.3);

    // ...and inline, where it disables the rest of one line only.
    const rec = readNamelist(
      '&OBST XB=0,1,0,1,0,1 ! and /tmp, which is not the end\n'
      + "      SURF_ID='W' /")[0];
    expect(rec.numbers('XB')).toEqual([0, 1, 0, 1, 0, 1]);
    expect(rec.string('SURF_ID')).toBe('W');
  });

  it('keeps a ! that is inside a string', () => {
    expect(readNamelist("&HEAD TITLE='Bob''s ! test' /")[0].string('TITLE'))
      .toBe("Bob's ! test");
  });

  it('does not let an ampersand in prose swallow the next record', () => {
    // Searching the text for the next `&` does worse than read prose as input: `R&D`
    // starts a `&D` record whose body runs to the next `/`, and the real record in
    // between disappears without a trace.
    const records = readNamelist(
      "&HEAD CHID='t' /\nR&D department reference note\n&OBST XB=0,1,0,1,0,1 /\n&TAIL /\n");
    expect(records.map((r) => r.group)).toEqual(['HEAD', 'OBST', 'TAIL']);
    expect(records[1].line).toBe(3);
  });

  it('still reads a second record written after the first one’s slash', () => {
    expect(readNamelist('&OBST XB=1,2,3,4,5,6 / &VENT XB=1,2,3,4,5,5 /').map((r) => r.group))
      .toEqual(['OBST', 'VENT']);
  });

  it('expands repeat counts and accumulates subscripted assignments', () => {
    expect(readNamelist("&OBST SURF_ID6=6*'WALL' /")[0].strings('SURF_ID6'))
      .toEqual(['WALL', 'WALL', 'WALL', 'WALL', 'WALL', 'WALL']);

    const layered = readNamelist(
      "&SURF ID='S', MATL_ID(1,1)='GYP', MATL_ID(2,1)='WOOL', THICKNESS(1:2)=0.012,0.2 /")[0];
    expect(layered.strings('MATL_ID')).toEqual(['GYP', 'WOOL']);
    expect(layered.numbers('THICKNESS')).toEqual([0.012, 0.2]);
  });

  it('reads logicals, Fortran exponents and escaped quotes', () => {
    const rec = readNamelist('&SURF DEFAULT=.TRUE., X=.F., C=1.2D3, D=4.5e-2 /')[0];
    expect(rec.boolean('DEFAULT')).toBe(true);
    expect(rec.boolean('X')).toBe(false);
    expect(rec.number('C')).toBe(1200);
    expect(rec.number('D')).toBe(0.045);
    expect(readNamelist("&HEAD TITLE='Bob''s test' /")[0].string('TITLE')).toBe("Bob's test");
  });

  it('stops reading at TAIL', () => {
    const records = readNamelist(
      '&OBST XB=0,1,0,1,0,1 /\n&TAIL /\n&OBST XB=9,9,9,9,9,9 /');
    expect(records.map((r) => r.group)).toEqual(['OBST', 'TAIL']);
  });

  it('names the mistake people actually make when pasting one record', () => {
    expect(() => readOneRecord('OBST XB=0,1,0,1,0,2 /'))
      .toThrow(/No "&" to start the record/);
    expect(() => readOneRecord('&OBST XB=0,1,0,1,0,2 /\n&OBST XB=1,2,0,1,0,2 /'))
      .toThrow(NamelistError);
    expect(() => readOneRecord('   ')).toThrow(NamelistError);
  });
});

// -- the sample, end to end -----------------------------------------------

describe('importing the sample', () => {
  it('produces a structurally valid plan with the expected objects', () => {
    const result = sample();
    expect(validateStructure(result.doc)).toEqual([]);
    expect(result.counts).toEqual({
      wall: 4, ceiling: 1, burner: 1, heatFluxSensor: 23, thermocouple: 2,
    });
  });

  it('lands the origin on the burner centre at floor level', () => {
    // The fire is a 0.2 m square at (0.1, 0.1) standing on a slab whose top is z = 0.
    const result = sample();
    expect(result.originM).toEqual([0.1, 0.1, 0]);
    expect(only(result, 'burner').transform!.position_m).toEqual([0, 0, 0]);
    expect(result.doc.meta!.source!.originOffset_m).toEqual([0.1, 0.1, 0]);
  });

  it('takes the floor from the slab top, not the bottom of the mesh', () => {
    // The meshes start at z = -0.2 and the floor slab's top is z = 0. Taking the mesh
    // would put every height in the plan 200 mm out and leave the burner floating.
    expect(only(sample(), 'ceiling') as CeilingObject).toMatchObject({ height_m: 2.4 });
  });

  it('computes HRR from HRRPUA, area and the ramp peak', () => {
    // 7500 kW/m² over a 0.2 × 0.2 m face, RAMP peaking at F = 1.0.
    const burner = only(sample(), 'burner') as BurnerObject;
    expect(burner.fire!.hrr_kw).toBeCloseTo(300, 9);
    expect(burner.footprint).toEqual({ shape: 'square', size_m: [0.2, 0.2] });
    expect(burner.rimHeight_m).toBeCloseTo(0.1, 9);
    expect(burner.fire!.fuel).toBe('polyurethane');
  });

  it('spells a long simulation time the way Python spells it', () => {
    // This string ends up in meta.notes, so the two importers have to agree on it.
    // Python's "{:g}" goes exponential at 1e6 and JavaScript does not, which would
    // have written "1e+06 s" there and "1000000 s" here.
    const doc = fdsToPlan('&TIME T_END=1000000. /\n&OBST XB=0,1,0,0.1,0,2 /\n').doc;
    expect(doc.meta!.notes).toContain('T_END 1000000 s');
  });

  it('never invents a radiative fraction', () => {
    // The only RADIATIVE_FRACTION in the sample is on a REAC line FDS never reads.
    const burner = only(sample(), 'burner') as BurnerObject;
    expect('radiativeFraction' in burner.fire!).toBe(false);
  });

  it('turns a thin tall obstruction into a wall on its centreline', () => {
    // &OBST XB=-0.10,2.50, 3.60,3.70, -0.10,2.5 runs along X at y = 3.65.
    const wall = byId(sample(), 'wall-1') as WallObject;
    nearPairs(wall.polyline_m, [[-0.2, 3.55], [2.4, 3.55]]);
    expect(wall.thickness_m).toBeCloseTo(0.1, 9);
    // Buried 100 mm into the slab; clamping the base without shortening the wall
    // would put its top at 2.6 m instead of the 2.5 m the file asks for.
    expect(wall.baseHeight_m).toBe(0);
    expect(wall.height_m).toBeCloseTo(2.5, 9);
  });

  it('turns a HOLE into an opening positioned along the wall', () => {
    const openings = (byId(sample(), 'wall-1') as WallObject).openings!;
    expect(openings).toHaveLength(1);
    expect(openings[0].offset_m).toBeCloseTo(0.9, 9);
    expect(openings[0].width_m).toBeCloseTo(0.8, 9);
    expect(openings[0].height_m).toBeCloseTo(2, 9);
  });

  it('collapses a vertical run of devices into one rake', () => {
    const rake = byId(sample(), 'tc-tc1-tc22') as ThermocoupleObject;
    expect(rake.beadOffsets_m).toHaveLength(22);
    expect(rake.transform!.position_m).toEqual([0, -0.1, 0.2]);
    // The quantity is on the &PROP, not the &DEVC: a reader that only looks at
    // QUANTITY imports none of this file's thermocouples.
    expect(rake.thermocouple!.beadDiameter_mm).toBeCloseTo(3.2, 9);
  });

  it('keeps a wall temperature distinct from a gas temperature at the same point', () => {
    const result = sample();
    expect((byId(result, 'tc-c1-c22') as ThermocoupleObject).mount!.type).toBe('wall');
    expect((byId(result, 'tc-tc1-tc22') as ThermocoupleObject).mount!.type).toBe('pole');
  });

  it('reads IOR as the gauge normal', () => {
    // IOR=2 means the device sits on a surface facing +Y, and the fire is on the +Y
    // side of it.
    const gauge = byId(sample(), 'hf-hf-1');
    const position = gauge.transform!.position_m;
    const target = gauge.transform!.aimTarget_m!;
    expect(target[1]).toBeGreaterThan(position[1]);
    expect(target[0]).toBeCloseTo(position[0], 9);
    expect(target[2]).toBeCloseTo(position[2], 9);
  });

  it('reports a burning lining without offering it as a burner', () => {
    // The sample's 'UPHOLSTERY' burns on three wall faces and the ceiling soffit.
    // None of those is a floor-standing source, so the only candidate is the
    // ignition pan -- and the lining is named in the report rather than passed over.
    // Offering it as a burner produced a 2.6 x 3.7 m pan with a 2.4 m rim: a solid
    // box the size of the room, reaching from the floor to the ceiling.
    const result = sample();
    expect(result.burnerSurf).toBe('FIRE');
    expect(result.burnerCandidates).toEqual(['FIRE']);
    const lining = result.issues.filter((i) => i.code === 'fds-fire-not-a-burner');
    expect(lining).toHaveLength(1);
    expect(lining[0].message).toContain('UPHOLSTERY');
  });

  it('names everything it skipped', () => {
    const skipped = sample().issues.find((i) => i.code === 'fds-not-imported')!;
    for (const group of ['&MESH', '&MATL', '&SLCF', '&BNDF']) {
      expect(skipped.message).toContain(group);
    }
  });

  it('will not take the sample’s ceiling soffit lining as a burner, even when asked', () => {
    // A downward-facing fire face has a footprint, which is what makes it dangerous:
    // taken as a burner, its rim height is the height of the ceiling.
    // Asking for it anyway falls back to the pan, and says so rather than quietly
    // describing a fire somewhere else.
    const result = fdsToPlan(SAMPLE_TEXT, null, { burnerSurf: 'UPHOLSTERY' });
    expect(result.burnerSurf).toBe('FIRE');
    expect(result.issues.map((i) => i.code)).toContain('fds-burner-unavailable');
    expect(validateStructure(result.doc)).toEqual([]);
  });

  it('lets the burner choice be overridden between real pans', () => {
    const twoPans = '&MESH IJK=40,40,30, XB=-1,5,-1,5,0,3 /\n'
      + "&SURF ID='SMALL' HRRPUA=500. /\n"
      + "&SURF ID='BIG' HRRPUA=100. /\n"
      + "&VENT XB=0,0.5,0,0.5,0.5,0.5, SURF_ID='SMALL' /\n"
      + "&VENT XB=2,4,2,4,0.5,0.5, SURF_ID='BIG' /\n";
    const result = fdsToPlan(twoPans);
    expect(result.burnerCandidates).toEqual(['BIG', 'SMALL']);
    expect(result.burnerSurf).toBe('SMALL');       // the most compact one
    expect(result.issues.map((i) => i.code)).toContain('fds-fire-choice');

    expect(fdsToPlan(twoPans, null, { burnerSurf: 'BIG' }).burnerSurf).toBe('BIG');
  });

  it('does not move the instruments when geometry is skipped', () => {
    // `geometry: false` means "do not emit walls", not "do not read them". The
    // obstructions are what locate the fire and the floor, and therefore the origin.
    const full = sample();
    const devicesOnly = fdsToPlan(SAMPLE_TEXT, 'IR401_0.fds', { geometry: false });
    near(devicesOnly.originM, full.originM);
    expect(devicesOnly.counts.wall).toBeUndefined();
    near(
      byId(devicesOnly, 'hf-hf-1').transform!.position_m,
      byId(full, 'hf-hf-1').transform!.position_m,
    );
  });

  it('can leave the rakes ungrouped', () => {
    expect(fdsToPlan(SAMPLE_TEXT, null, { groupRakes: false }).counts.thermocouple).toBe(44);
  });
});

// -- obstructions and format 1.2 ------------------------------------------

describe('obstructions', () => {
  const withCouch = () => fdsToPlan(
    "&SURF ID='B', HRRPUA=500. /\n&SURF ID='I' /\n"
    + "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
    + "&OBST XB=1.0,3.0, 2.0,2.9, 0.0,0.8, ID='Couch' /\n");

  it('gives a solid block an origin at the centre of its base', () => {
    const box = only(withCouch(), 'obstruction') as ObstructionObject;
    expect(box.name).toBe('Couch');
    near(box.size_m, [2, 0.9, 0.8]);
    // re-origined onto the burner at (0.1, 0.1)
    expect(box.transform!.position_m[0]).toBeCloseTo(1.9, 9);
    expect(box.transform!.position_m[1]).toBeCloseTo(2.35, 9);
    expect(box.transform!.position_m[2]).toBeCloseTo(0, 9);
  });

  it('makes the plan declare format 1.2', () => {
    expect(requiredFormatVersion(withCouch().doc)).toBe('1.2.0');
    // ...and nothing in the sample does, so that stays 1.1.
    expect(requiredFormatVersion(sample().doc)).toBe('1.1.0');
  });

  it('rejects a degenerate box at load time', () => {
    const doc = withCouch().doc;
    (doc.objects.find((o) => o.type === 'obstruction') as ObstructionObject).size_m = [1, 0, 1];
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-size');
  });

  it('normalises an XB written backwards', () => {
    const result = fdsToPlan("&OBST XB=3.0,1.0, 2.9,2.0, 0.8,0.0, ID='c' /\n");
    near((only(result, 'obstruction') as ObstructionObject).size_m, [2, 0.9, 0.8]);
  });

  it('replicates a MULT', () => {
    const result = fdsToPlan(
      "&MULT ID='row', DX=1.0, I_LOWER=0, I_UPPER=3 /\n"
      + "&OBST XB=0,0.2,0,0.2,0,1.0, MULT_ID='row', ID='post' /\n");
    const boxes = result.doc.objects.filter((o) => o.type === 'obstruction');
    expect(boxes).toHaveLength(4);
    expect(new Set(boxes.map((b) => b.id)).size).toBe(4);
  });
});

// -- the fire ------------------------------------------------------------

describe('finding the fire', () => {
  it('keeps a burner vent that sits flush with the mesh boundary', () => {
    // A floor fire in a domain that starts at the floor is written flush with a
    // domain face. Dropping it as an OPEN-style boundary vent left the plan with no
    // fire, an origin fallen back to the mesh centre, and a warning telling the user
    // their own input has no heat source.
    const result = fdsToPlan(
      '&MESH IJK=40,40,30, XB=0,4,0,4,0,3 /\n'
      + "&SURF ID='B' HRRPUA=100. /\n"
      + "&VENT XB=0,1,0,1,0,0, SURF_ID='B' /\n");
    expect((only(result, 'burner') as BurnerObject).fire!.hrr_kw).toBeCloseTo(100, 9);
    near(result.originM.slice(0, 2), [0.5, 0.5]);
    expect(result.issues.map((i) => i.code)).not.toContain('fds-no-fire');
  });

  it('makes a burner of every face of the chosen surface', () => {
    // One &SURF over several &VENTs is two burners in a room, not one. The second
    // fire location used to vanish while the conversion reported success.
    const result = fdsToPlan(
      '&MESH IJK=40,40,30, XB=-1,5,-1,5,0,3 /\n'
      + "&SURF ID='B' HRRPUA=100. /\n"
      + "&VENT XB=0,1,0,1,0.5,0.5, SURF_ID='B' /\n"
      + "&VENT XB=3,4,3,4,0.5,0.5, SURF_ID='B' /\n");
    expect(result.counts.burner).toBe(2);
    expect(result.issues.map((i) => i.code)).toContain('fds-burner-instances');
    // The primary is the one the frame was built around, so it is at the origin.
    near(primaryBurner(result.doc)!.transform!.position_m.slice(0, 2), [0, 0]);
  });

  it('reports a wall fire rather than flattening it into a zero-area burner', () => {
    // A vertical heat-release face has no plan footprint. Writing one out as
    // `size_m: [1, 0]` produced a plan that saved and then would not reopen.
    const result = fdsToPlan(
      '&MESH IJK=40,40,30, XB=-1,5,-1,5,0,3 /\n'
      + "&SURF ID='B' HRRPUA=100. /\n"
      + "&VENT XB=1,2,1,1,0,2, SURF_ID='B' /\n");
    expect(result.counts.burner).toBeUndefined();
    expect(result.issues.map((i) => i.code)).toContain('fds-fire-not-a-burner');
    expect(validateStructure(result.doc)).toEqual([]);
  });

  it('never takes an overhead slab as the floor when the fire is below every slab', () => {
    // A floor-level fire under a ceiling, with no floor slab drawn. The fallback to
    // "any slab" chose the ceiling: origin at its top, the ceiling itself dropped
    // as floor geometry, and a device at 1 m placed at -2.1 m.
    const result = fdsToPlan(
      "&HEAD CHID='review-floor' /\n&MESH XB=0,4,0,4,0,4 /\n"
      + "&SURF ID='B', HRRPUA=100 /\n&VENT XB=0,1,0,1,0,0, SURF_ID='B' /\n"
      + '&OBST XB=0,4,0,4,3,3.1 /\n'
      + "&DEVC XYZ=1,1,1, QUANTITY='TEMPERATURE' /\n&TAIL /\n");
    near(result.originM, [0.5, 0.5, 0]);
    expect((only(result, 'ceiling') as CeilingObject).height_m).toBeCloseTo(3, 9);
    expect((only(result, 'thermocouple') as ThermocoupleObject).transform!.position_m[2])
      .toBeCloseTo(1, 9);
    // And it says the floor was inferred rather than found.
    const note = result.issues.find((i) => i.code === 'fds-floor-inferred');
    expect(note?.message).toContain('kept as ceilings');
  });

  it('reads a downward-facing vent as a soffit fire, not an upward pan', () => {
    // Every horizontal vent used to be +z. This one is on the underside of a
    // ceiling, IOR=-3, and became a square burner with a 3 m rim: an upward flame
    // on a three-metre-high pan.
    const model = (ior: string): string =>
      "&HEAD CHID='downward' /\n&MESH XB=0,4,0,4,0,4 /\n"
      + '&OBST XB=0,4,0,4,-0.1,0 /\n&OBST XB=0,4,0,4,3,3.1 /\n'
      + "&SURF ID='B', HRRPUA=100 /\n"
      + `&VENT XB=1,2,1,2,3,3, SURF_ID='B'${ior} /\n&TAIL /\n`;
    for (const ior of [', IOR=-3', '']) {
      const result = fdsToPlan(model(ior));
      expect(result.counts.burner).toBeUndefined();
      expect(result.issues.map((i) => i.code)).toContain('fds-fire-not-a-burner');
      expect((only(result, 'ceiling') as CeilingObject).height_m).toBeCloseTo(3, 9);
      expect(validateStructure(result.doc)).toEqual([]);
    }
    // The same footprint on the TOP of the floor slab is the ordinary burner.
    const floorFire = fdsToPlan(model('').replace('XB=1,2,1,2,3,3', 'XB=1,2,1,2,0,0'));
    expect(floorFire.counts.burner).toBe(1);
    // An explicit IOR wins over inspection: +3 on the underside is still upward.
    expect(fdsToPlan(model(', IOR=3')).counts.burner).toBe(1);
  });

  it('gives a zero-thickness obstruction a drawable thickness and says so', () => {
    // FDS thin obstructions -- glazing, partitions -- are ordinary. A wall of
    // thickness zero and a slab of thickness zero were both objects the editor
    // refused to reopen, which blocked the whole import.
    const result = fdsToPlan(
      "&SURF ID='B' HRRPUA=100. /\n"
      + "&OBST ID='floor' XB=-1,5,-1,5,-0.1,0 /\n"
      + "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
      + "&OBST ID='glazing' XB=0,2,1,1,0,2.4 /\n"
      + "&OBST ID='shelf' XB=2,3,2,3,1.2,1.2 /\n");
    const wall = byId(result, 'wall-glazing') as WallObject;
    expect(wall.thickness_m).toBe(THIN_M);
    const shelf = byId(result, 'ceiling-shelf') as CeilingObject;
    expect(shelf.thickness_m).toBe(THIN_M);
    expect(shelf.height_m).toBeCloseTo(1.2, 9);
    expect(validateStructure(result.doc)).toEqual([]);
    expect(result.issues.find((i) => i.code === 'fds-thin-geometry')?.message)
      .toContain('2 zero-thickness');
  });

  it('reads a ramp that never leaves zero as a surface switched off', () => {
    // `peak || 1` read "no ramp" and "a peak of zero" as the same thing, and turned
    // a burner the input switches off into the largest fire in the file.
    const result = fdsToPlan(
      "&SURF ID='B' HRRPUA=100. RAMP_Q='r' /\n"
      + "&RAMP ID='r' T=0. F=0.0 /\n"
      + "&RAMP ID='r' T=10. F=0.0 /\n"
      + "&VENT XB=0,1,0,1,0.5,0.5, SURF_ID='B' /\n");
    expect(result.counts.burner).toBeUndefined();
    expect(result.issues.map((i) => i.code)).toContain('fds-surface-off');
  });
});

// -- geometry that is not a ceiling ---------------------------------------

describe('slabs at floor level', () => {
  it('treats every tile of a tiled floor as floor', () => {
    // A meshed model tiles its floor, one &OBST per mesh. Skipping only the lowest
    // left the rest to be converted as slabs at floor level -- ceilings with a
    // negative height, which no schema version accepts.
    const result = fdsToPlan(
      '&MESH IJK=40,40,30, XB=-1,5,-1,5,-1,3 /\n'
      + "&SURF ID='B' HRRPUA=100. /\n"
      + "&OBST ID='floor-a' XB=0,2,0,4,-0.1,0.0 /\n"
      + "&OBST ID='floor-b' XB=2,4,0,4,-0.1,0.0 /\n"
      + "&VENT XB=1,2,1,2,0.0,0.0, SURF_ID='B' /\n");
    expect(result.counts.ceiling).toBeUndefined();
    expect(validateStructure(result.doc)).toEqual([]);
  });

  it('makes a box, not a ceiling, of a slab resting on the floor', () => {
    // A plinth's soffit height is zero, which is not a ceiling and not a valid one.
    const result = fdsToPlan(
      "&SURF ID='B' HRRPUA=500. /\n"
      + "&OBST ID='floor' XB=-1,5,-1,5,-0.1,0.0 /\n"
      + "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
      + "&OBST ID='plinth' XB=1,3,1,3,0,0.15 /\n");
    expect(result.counts.ceiling).toBeUndefined();
    expect((only(result, 'obstruction') as ObstructionObject).name).toBe('plinth');
    expect(validateStructure(result.doc)).toEqual([]);
  });
});

// -- &MULT ----------------------------------------------------------------

describe('MULT', () => {
  it('moves the domain, and therefore the origin, when it is on a mesh', () => {
    // With no burner the origin is the centre of the domain, so a MULT_ID this
    // reader ignored shifted every imported coordinate by a mesh width.
    const result = fdsToPlan(
      "&MULT ID='m' DX=10, I_UPPER=1 /\n"
      + "&MESH IJK=10,10,10, XB=0,10,0,4,0,3, MULT_ID='m' /\n"
      + "&DEVC ID='tc', QUANTITY='THERMOCOUPLE', XYZ=15,2,1 /\n");
    expect(result.originM[0]).toBeCloseTo(10, 9);
    expect((only(result, 'thermocouple') as ThermocoupleObject).transform!.position_m[0])
      .toBeCloseTo(5, 9);
  });

  it('leaves a hole where a skip range asks for one', () => {
    const result = fdsToPlan(
      "&MULT ID='row', DX=1.0, I_LOWER=0, I_UPPER=3, I_LOWER_SKIP=1, I_UPPER_SKIP=2 /\n"
      + "&OBST XB=0,0.2,0,0.2,0,1.0, MULT_ID='row', ID='post' /\n");
    const posts = result.doc.objects.filter((o) => o.type === 'obstruction');
    expect(posts).toHaveLength(2);
    const xs = posts.map((o) => o.transform!.position_m[0]).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(3, 9);
  });
});

// -- malformed input and unresolved includes ------------------------------

describe('what an import refuses to guess', () => {
  it('skips a truncated XB rather than throwing', () => {
    const result = fdsToPlan("&HEAD CHID='t' /\n&OBST XB=0,1,2 /\n&TAIL /\n");
    expect(result.counts).toEqual({});
  });

  it('splices an include where the &CATF sits, not after &TAIL', async () => {
    // &CATF belongs in the body, before &TAIL -- that is where the official
    // validation cases put it -- and reading stops at &TAIL. A child appended after
    // the parent's last line is a child nobody reads.
    const files: Record<string, string> = {
      'child.fds': "&SURF ID='B' HRRPUA=100. /\n&VENT XB=1,2,1,2,0.5,0.5, SURF_ID='B' /\n",
    };
    const spliced = await spliceFdsIncludes(
      "&HEAD CHID='root' /\n&MESH IJK=10,10,10, XB=0,4,0,4,0,3 /\n"
      + "&CATF OTHER_FILES='child.fds','gone.fds' /\n&TAIL /\n",
      async (name) => files[name] ?? null,
    );
    expect(spliced.unresolved).toEqual(['gone.fds']);

    const result = fdsToPlan(spliced.text, 'root.fds', { includesResolved: true });
    expect((only(result, 'burner') as BurnerObject).fire!.hrr_kw).toBeCloseTo(100, 9);
    expect(result.issues.map((i) => i.code)).not.toContain('fds-catf-unresolved');
  });

  it('splices includes as FDS copies them, and reports everything else', async () => {
    // FDS copies an included file without its &HEAD and only up to its first &TAIL
    // or &CATF (COPY_FILE_TO_CAT, read.f90), then carries on with the parent. So a
    // child's &TAIL ends the child, not the model, and nested includes are not read.
    // Mirrored in python/tests/test_fds.py.
    const files: Record<string, string> = {
      'child.fds': "&HEAD CHID='child' /\n&OBST XB=0,2,0,0.1,0,2 /\n&TAIL /\n&OBST XB=3,5,0,0.1,0,2 /\n",
      'common.fds': "&SURF ID='C' /\n",
      'a.fds': "&CATF OTHER_FILES='common.fds' /\n&OBST XB=0,0.1,0,2,0,2 /\n",
    };
    const spliced = await spliceFdsIncludes(
      "&HEAD CHID='catf' /\n&CATF OTHER_FILES='a.fds','a.fds','catf.fds','gone.fds','child.fds' /\n"
      + "&DEVC ID='parent', XYZ=1,1,1, QUANTITY='TEMPERATURE' /\n&TAIL /\n",
      async (name) => files[name] ?? null, 'catf.fds',
    );
    const codes = spliced.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(
      ['fds-catf-repeat', 'fds-catf-cycle', 'fds-catf-missing', 'fds-catf-tail', 'fds-catf-nested']));
    expect(spliced.issues.find((i) => i.code === 'fds-catf-tail')?.message).toContain('child.fds');
    expect(spliced.issues.find((i) => i.code === 'fds-catf-missing')?.message).toContain('gone.fds');

    // And the conversion carries them through, ahead of its own findings.
    const result = fdsToPlan(spliced.text, 'catf.fds',
      { includesResolved: true, includeIssues: spliced.issues });
    expect(result.issues.slice(0, spliced.issues.length)).toEqual(spliced.issues);
    expect(result.counts.wall).toBe(1);           // only the child's box before its &TAIL
    expect(result.counts.thermocouple).toBe(1);   // the parent carries on
    expect(result.doc.meta?.title).toBe('catf');  // the child's &HEAD is not copied
    expect(result.issues.map((i) => i.code)).not.toContain('fds-catf-unresolved');
  });

  it('says so when &CATF pulls in files nobody read', () => {
    // The browser is handed one file's bytes and cannot go looking. Silence there
    // would present a fraction of a model as a whole one.
    const result = fdsToPlan(
      "&HEAD CHID='t' /\n&CATF OTHER_FILES='geometry.fds' /\n&TAIL /\n");
    const catf = result.issues.find((i) => i.code === 'fds-catf-unresolved');
    expect(catf?.message).toContain('geometry.fds');
  });

  it('declares the version its own contents need, not the baseline', () => {
    // Python's importer does this, with a comment explaining why: an import is not
    // an edit in progress, and a fresh one should not open reporting
    // `version-understated` against itself.
    const result = fdsToPlan(
      "&SURF ID='B', HRRPUA=500. /\n"
      + "&OBST XB=0,0.2,0,0.2,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n"
      + "&OBST XB=1.0,3.0, 2.0,2.9, 0.0,0.8, ID='Couch' /\n");
    expect(result.doc.version).toBe('1.2.0');
    expect(checkPlan(result.doc).map((i) => i.code)).not.toContain('version-understated');
  });
});

// -- one record at a time, for the paste box ------------------------------

describe('creating one object from a pasted record', () => {
  it('classifies a pasted &OBST exactly as the full importer would', () => {
    const rec = readOneRecord("&OBST XB=-0.10,2.50,3.60,3.70,-0.10,2.5, SURF_ID='WALL' /");
    const wall = obstructionFromRecord(rec, [0.1, 0.1, 0]) as WallObject;
    expect(wall.type).toBe('wall');
    nearPairs(wall.polyline_m, [[-0.2, 3.55], [2.4, 3.55]]);
    expect(wall.thickness_m).toBeCloseTo(0.1, 9);
  });

  it('returns null for a record with no XB', () => {
    expect(obstructionFromRecord(readOneRecord("&HEAD CHID='x' /"))).toBeNull();
  });

  it('refuses a &VENT, which is a face and not a box', () => {
    // A planar vent pasted as geometry became an obstruction with size [1, 1, 0]:
    // it displayed, it saved, and the loader then rejected the file. The full
    // import never makes geometry of a vent, and neither does this.
    expect(obstructionFromRecord(readOneRecord('&VENT XB=0,1,0,1,0,0 /'))).toBeNull();
    expect(obstructionFromRecord(readOneRecord("&VENT XB=0,1,0,1,0,0, SURF_ID='B' /"))).toBeNull();
  });

  it('still makes a valid object of a thin &OBST pasted on its own', () => {
    const plate = obstructionFromRecord(readOneRecord('&OBST XB=0,2,1,1,0,2.4 /')) as WallObject;
    expect(plate.type).toBe('wall');
    expect(plate.thickness_m).toBe(THIN_M);
    const doc = newPlan('paste');
    doc.objects.push(plate);
    expect(validateStructure(doc)).toEqual([]);
  });

  it('refuses a record whose group is not one it can read', () => {
    // Every one of these carries an XB, and none of them is a wall; &SLCF carries a
    // QUANTITY and an XYZ as well, and is a slice file rather than a thermocouple.
    expect(obstructionFromRecord(readOneRecord('&MESH IJK=10,10,10, XB=0,1,0,1,0,1 /'))).toBeNull();
    expect(obstructionFromRecord(readOneRecord('&INIT XB=0,1,0,1,0,1, TEMPERATURE=100. /'))).toBeNull();
    expect(deviceFromRecord(readOneRecord("&SLCF QUANTITY='TEMPERATURE', XYZ=1,1,1 /"))).toBeNull();
    // A &DEVC carrying an XB is still a device, not geometry.
    expect(obstructionFromRecord(
      readOneRecord("&DEVC QUANTITY='TEMPERATURE', XYZ=1,1,1, XB=0,1,0,1,0,1 /"))).toBeNull();
    expect(deviceFromRecord(readOneRecord("&DEVC QUANTITY='TEMPERATURE', XYZ=1,1,1 /"))!.type)
      .toBe('thermocouple');
  });
});

// -- the FDS coordinate view ----------------------------------------------

describe('reading a plan object as FDS spells it', () => {
  it('gives back the XB the file contained, in the file\'s own coordinates', () => {
    // The whole point of keeping the origin offset: an engineer comparing the plan
    // against their input should see the same six numbers.
    const result = sample();
    const frame = fdsFrame(result.doc);
    expect(frame.fromImport).toBe(true);
    expect(frame.file).toBe('IR401_0.fds');

    const view = xbOfObject(byId(result, 'wall-1'), frame.offset)!;
    expect(view.editable).toBe(true);
    // &OBST XB=-0.10,2.50, 3.60,3.70, -0.10,2.5 -- with Z1 at the floor, because
    // the plan clamped the buried 100 mm away rather than keeping a wall below the
    // slab it stands on.
    near(view.xb, [-0.1, 2.5, 3.6, 3.7, 0, 2.5]);
  });

  it('round-trips an XB through the object and back', () => {
    const result = sample();
    const wall = byId(result, 'wall-1');
    const next: Xb = [-0.1, 4.0, 3.6, 3.7, 0, 2.5];
    expect(applyXbToObject(wall, next, [0.1, 0.1, 0])).toBeNull();
    near(xbOfObject(wall, [0.1, 0.1, 0])!.xb, next);
  });

  it('round-trips a wall XB below the floor into a loadable document', () => {
    const result = sample();
    const wall = byId(result, 'wall-1');
    const offset: Vec3 = [0.1, 0.1, 3];
    const next: Xb = [0, 2, 0, 0.1, 2, 4];
    expect(applyXbToObject(wall, next, offset)).toBeNull();
    near(xbOfObject(wall, offset)!.xb, next);
    expect(validateStructure(JSON.parse(serializePlan(result.doc)))).toEqual([]);
  });

  it('refuses an XB that would make the object one the loader rejects', () => {
    // A ceiling typed with Z1 at the floor is a slab with a soffit height of zero
    // -- not a ceiling, and not a valid one. It used to be written anyway, and the
    // plan then saved and failed to reopen with `bad-height`.
    const result = sample();
    const slab = byId(result, 'ceiling-1') as CeilingObject;
    const before = JSON.stringify(slab);
    const atFloor: Xb = [0, 2, 0, 2, 0, 0.2];
    expect(xbProblem(slab, atFloor)).toContain('soffit');
    expect(applyXbToObject(slab, atFloor)).toContain('soffit');
    expect(JSON.stringify(slab)).toBe(before);           // nothing was changed
    expect(validateStructure(result.doc)).toEqual([]);

    // The same slab a metre up is fine.
    expect(applyXbToObject(slab, [0, 2, 0, 2, 1, 1.2])).toBeNull();
    expect(slab.height_m).toBeCloseTo(1, 9);
    expect(validateStructure(result.doc)).toEqual([]);

    // A wall with no height, a box with no depth: refused the same way.
    const wall = byId(result, 'wall-1');
    expect(xbProblem(wall, [0, 2, 0, 0.1, 1, 1])).toContain('height');
    const box = { id: 'b', type: 'obstruction', transform: { position_m: [0, 0, 0] }, size_m: [1, 1, 1] } as unknown as ObstructionObject;
    expect(xbProblem(box, [0, 1, 0, 0, 0, 1])).toContain('three extents');
    expect(xbProblem(box, [0, 1, 0, 1, 0, 1])).toBeNull();
  });

  it('reports a bounding box as read-only rather than squaring off geometry', () => {
    const result = sample();
    const wall = byId(result, 'wall-1') as WallObject;

    // A diagonal run is not an XB, and writing one back would straighten it.
    wall.polyline_m = [[-0.2, 3.55], [2.4, 4.2]];
    let view = xbOfObject(wall)!;
    expect(view.editable).toBe(false);
    expect(view.why).toContain('diagonal');

    // Nor is a three-point run.
    wall.polyline_m = [[-0.2, 3.55], [2.4, 3.55], [2.4, 1.0]];
    view = xbOfObject(wall)!;
    expect(view.editable).toBe(false);
    expect(view.why).toContain('3 points');
  });

  it('gives a rotated object the box that actually contains it', () => {
    // The view promises "the bounding box" for anything it cannot write back. A
    // 2 x 1 box yawed 90 degrees occupies 1 x 2 of the world, and reporting its
    // unrotated extents puts the box somewhere it is not.
    const doc = newPlan('rotated');
    const box = {
      id: 'b', type: 'obstruction',
      transform: { position_m: [0, 0, 0], rotation_quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      size_m: [2, 1, 1],
    } as unknown as ObstructionObject;
    doc.objects.push(box);

    const view = xbOfObject(box)!;
    expect(view.editable).toBe(false);
    near(view.xb, [-0.5, 0.5, -1, 1, 0, 1]);
  });

  it('will not offer an XB for a circular pan', () => {
    const doc = fdsToPlan(
      "&SURF ID='B', HRRPUA=500. /\n&SURF ID='I' /\n"
      + "&OBST XB=0,1,0,1,0,0.1, SURF_ID6='I','I','I','I','I','B' /\n").doc;
    const burner = doc.objects.find((o) => o.type === 'burner') as BurnerObject;
    burner.footprint = { shape: 'circle', diameter_m: 0.6, size_m: null };
    const view = xbOfObject(burner)!;
    expect(view.editable).toBe(false);
    expect(view.why).toContain('circular');
  });

  it('reads a gauge\'s IOR back off its normal, and only when it is on an axis', () => {
    const result = sample();
    const gauge = byId(result, 'hf-hf-1');
    expect(xyzOfObject(gauge, result.originM)!.ior).toBe(2);
    near(xyzOfObject(gauge, result.originM)!.xyz, [0.1, 0.0, 0.2]);

    // The last gauge in the file sits on the floor looking up.
    expect(xyzOfObject(byId(result, 'hf-hf-23'), result.originM)!.ior).toBe(3);

    // A thermocouple has no facing, so it has no IOR either.
    const rake = xyzOfObject(byId(result, 'tc-tc1-tc22'), result.originM)!;
    expect(rake.aimable).toBe(false);
    expect(rake.ior).toBeNull();
  });

  it('says a plan built here has no source file to match', () => {
    // A plan authored in the editor, not converted. The XB view still works -- it is
    // a useful way to type a wall -- but it must not imply the numbers line up with
    // an input file, because there is no input file.
    const frame = fdsFrame(newPlan('by hand'));
    expect(frame.fromImport).toBe(false);
    expect(frame.file).toBeNull();
    expect(frame.offset).toEqual([0, 0, 0]);
  });
});

// -- the parity that matters ----------------------------------------------

describe('agreement with fireplan.fds', () => {
  it('reproduces the Python-written fixture byte for byte', () => {
    // Not a formatting check: it asserts the two importers make the same decisions
    // about every box, every device and the origin itself. Rebuild the fixture with
    // `python tools/build_fixtures.py` when a rule deliberately changes.
    const result = sample();
    result.doc.meta!.created = '2026-08-15T00:00:00Z';
    result.doc.meta!.modified = '2026-08-15T00:00:00Z';
    expect(serializePlan(result.doc)).toBe(GOLDEN_TEXT);
  });
});

// -- review 2026-09-22: shared cases, run by python/tests/test_fds.py too -------

describe('review 2026-09-22 FDS cases', () => {
  interface Case {
    name: string; text: string; counts: Record<string, number>;
    burnerHrrKw?: number | null; burnerRimM?: number; originZ?: number;
    sourceXyz?: Array<[string, Vec3]>; codes?: string[]; absentCodes?: string[];
  }
  const cases = JSON.parse(readFileSync(new URL('../../../fixtures/fds/review-cases.json', import.meta.url), 'utf8')) as Case[];
  const golden = JSON.parse(readFileSync(new URL('../../../fixtures/fds/review-cases.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

  for (const c of cases) {
    it(c.name, () => {
      const result = fdsToPlan(c.text, 'case.fds', { importedAt: IMPORTED_AT });
      expect(result.counts).toEqual(c.counts);
      const offset = result.doc.meta!.source!.originOffset_m!;
      if (c.originZ !== undefined) expect(offset[2]).toBeCloseTo(c.originZ, 9);
      const burner = result.doc.objects.find((o) => o.type === 'burner') as BurnerObject | undefined;
      if (c.burnerHrrKw !== undefined) {
        if (c.burnerHrrKw === null) expect(burner!.fire!.hrr_kw ?? null).toBeNull();
        else expect(burner!.fire!.hrr_kw).toBeCloseTo(c.burnerHrrKw, 9);
      }
      if (c.burnerRimM !== undefined) expect(burner!.rimHeight_m).toBeCloseTo(c.burnerRimM, 9);
      for (const [id, xyz] of c.sourceXyz ?? []) {
        near(byId(result, id).transform!.position_m.map((v, k) => v + offset[k]), xyz);
      }
      const codes = result.issues.map((i) => i.code);
      for (const code of c.codes ?? []) expect(codes).toContain(code);
      for (const code of c.absentCodes ?? []) expect(codes).not.toContain(code);
      // And the same bytes Python wrote for it (tools/build_fixtures.py).
      result.doc.meta!.created = '2026-08-15T00:00:00Z';
      result.doc.meta!.modified = '2026-08-15T00:00:00Z';
      expect(serializePlan(result.doc)).toBe(golden[c.name]);
    });
  }

  it('reads a hundred thousand boxes without overflowing the stack (FDSI-10)', () => {
    const values = Array.from({ length: 1_000_000 }, (_, i) => i - 500_000);
    expect(rangeOf(values)).toEqual([-500_000, 499_999]);
  });
});

describe('review 2026-09-22 namelist values', () => {
  it('keeps repeated quoted strings and null repeats in their places', () => {
    // Mirrored in python/tests/test_fds.py (FDSI-15, FDSI-16).
    const recs = readNamelist("&OBST SURF_ID6=2*'my surf','A' /\n&OBST SURF_ID6=2*,'A','B' /\n"
      + '&DEVC IOR=1D400 /');
    expect(recs[0].strings('SURF_ID6')).toEqual(['my surf', 'my surf', 'A']);
    expect(recs[1].strings('SURF_ID6')).toEqual([null, null, 'A', 'B']);
    expect(recs[2].number('IOR')).toBeNull();
  });
});
