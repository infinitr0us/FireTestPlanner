import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAndValidatePlan } from '../core/validate';
import { draftFromFile, parseTestData, suggestMappings } from './test-data-sources';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/test-data/${name}`, import.meta.url)));
const doc = () => parseAndValidatePlan(new TextDecoder().decode(fixture('test-data.ftp.json')));

describe('source drafts', () => {
  it('previews every workbook sheet and prefers the logger, with metadata units and hints', async () => {
    const bytes = fixture('logger-export.xlsx');
    const draft = await draftFromFile('logger-export.xlsx', bytes, doc());
    const expected = JSON.parse(new TextDecoder().decode(fixture('expected.json'))).files[0];
    expect(draft.sheets.map(s => s.name)).toEqual(expected.sheets.map((s: { sheet: string }) => s.sheet));
    expect(draft.defaultSheet).toBe('Log');
    expect(draft.preview).toHaveLength(12);
    expect(draft.channels).toHaveLength(13);
    expect(draft.channels[0]).toMatchObject({ name: 'HF east_23.17kW/m2permV', unit: 'V', samples: 598,
      span: [0, 599], calibration: { scale: 23170, inputUnit: 'V' } });
    expect(draft.shiftHint).toMatchObject({ seconds: 120 });
    expect(draft.suggestedMappings).toEqual([]);
    for (let i = 0; i < draft.sheets.length; i++) {
      expect(draft.sheets[i].table).toMatchObject(expected.sheets[i].layout);
      expect(draft.sheets[i].channelCount).toBe(expected.sheets[i].channels.length);
    }
  });

  it('suggests only exact FDS instrument names against the model fixture', async () => {
    const plan = doc(), source = plan.testData![1];
    const draft = await draftFromFile(source.file.path, fixture(source.file.path), plan);
    expect(draft.defaultSheetIndex).toBe(0);
    expect(draft.sheets[0].table.shape).toBe('fds');
    expect(draft.suggestedMappings).toEqual(source.channels);
    expect(suggestMappings(['TC low_2', 'HF east ', 'HF EAST', 'unknown'], plan))
      .toEqual([{ channel: 'TC low_2', object: 'tc-tree', bead: 1 }]);
    plan.objects.push({ ...plan.objects[1], id: 'duplicate' });
    expect(suggestMappings(['HF east'], plan)).toEqual([]);
  });

  it('supports xlsm, tsv and txt, honors saved layout, and refuses unsupported files', async () => {
    const plan = doc();
    const table = await parseTestData('run.xlsm', fixture('logger-export.xlsx'), plan.testData![0].table);
    expect(table.grid.length).toBe(601);
    expect(table.units.size).toBeGreaterThan(0);
    for (const ext of ['tsv', 'txt']) {
      const draft = await draftFromFile(`run.${ext}`, new TextEncoder().encode('Time\tHF east\ns\tkW/m2\n0\t2\n1\t3'), plan);
      expect(draft.channels[0].samples).toBe(2);
      expect(draft.suggestedMappings).toEqual([]);
    }
    await expect(draftFromFile('run.xls', new Uint8Array())).rejects.toThrow('Save as');
    const empty = await draftFromFile('empty.csv', new TextEncoder().encode('Metadata,Value\nRun,1'));
    expect(empty.defaultSheetIndex).toBeNull();
  });

  it('suggests the IDs Export to FDS writes, so a run of an imported plan maps back by name', () => {
    const room = parseAndValidatePlan(readFileSync(new URL('../../../fixtures/fds/room_corner.ftp.json', import.meta.url), 'utf8'));
    expect(suggestMappings(['BACK_TC_1', 'BACK_TC_6', 'BACK_WT_3', 'FLOOR_HF', 'NOT_A_DEVICE'], room)).toEqual([
      { channel: 'BACK_TC_1', object: 'tc-back-tc-1-back-tc-6', bead: 0 },
      { channel: 'BACK_TC_6', object: 'tc-back-tc-1-back-tc-6', bead: 5 },
      { channel: 'BACK_WT_3', object: 'tc-back-wt-1-back-wt-6', bead: 2 },
      { channel: 'FLOOR_HF', object: 'hf-floor-hf' },
    ]);
  });
});
