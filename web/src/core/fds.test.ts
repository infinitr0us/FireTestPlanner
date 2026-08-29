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

import { fdsToPlan, obstructionFromRecord, type FdsImportResult, type Xb } from './fds';
import {
  applyXbToObject,
  fdsFrame,
  xbOfObject,
  xyzOfObject,
} from './fdsview';
import { NamelistError, readNamelist, readOneRecord } from './namelist';
import { newPlan } from './plan';
import { serializePlan } from './serialize';
import type { BurnerObject, CeilingObject, ObstructionObject, PlanObject, ThermocoupleObject, WallObject } from './types';
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

  it('reports the heat-release surfaces it chose between, and everything it skipped', () => {
    const result = sample();
    expect(result.burnerSurf).toBe('FIRE');
    expect(result.burnerCandidates).toEqual(['FIRE', 'UPHOLSTERY']);
    const skipped = result.issues.find((i) => i.code === 'fds-not-imported')!;
    for (const group of ['&MESH', '&MATL', '&SLCF', '&BNDF']) {
      expect(skipped.message).toContain(group);
    }
  });

  it('lets the burner choice be overridden', () => {
    expect(fdsToPlan(SAMPLE_TEXT, null, { burnerSurf: 'UPHOLSTERY' }).burnerSurf)
      .toBe('UPHOLSTERY');
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
    applyXbToObject(wall, next, [0.1, 0.1, 0]);
    near(xbOfObject(wall, [0.1, 0.1, 0])!.xb, next);
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
