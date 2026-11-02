import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { collectKeys } from '../../scripts/i18n-source.mjs';
import { fr } from './i18n-fr';
import { formatNumber, formatQuantity, language, plural, setLanguage, subscribeLanguage, t } from './i18n';
import { formatLength, parseLength } from './display-units';
import { serializePlan } from '../core/serialize';
import { checkPlan, newPlan } from '../core/plan';
import { devicesToFds } from '../core/fds-export';
import { instrumentScheduleCsv } from '../core/instrument-schedule';
import { buildReportHtml } from '../export/report';
import { createBurner, createThermocouple } from '../core/factory';
import { BUILTIN_CAMERA_PRESETS } from '../core/presets';
import { presetNote } from './preset-labels';
import { fdsToPlan } from '../core/fds';
import { linkKindFor } from '../core/linked-files';

afterEach(() => { setLanguage('en'); vi.restoreAllMocks(); });

describe('interface language', () => {
  it('falls back to the exact English message and warns once in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLanguage('fr');
    expect(t('Missing test key {name}', { name: 'crew' })).toBe('Missing test key crew');
    t('Missing test key {name}');
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('substitutes without translating names or interpreting replacement syntax', () => {
    setLanguage('fr');
    expect(t('Object "{p1}": {p2}', { p1: 'Open $& <crew>', p2: 'file.1.2.csv' }))
      .toBe('Objet « Open $& <crew> » : file.1.2.csv');
    expect(t('Name')).toBe('Nom');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('toString')).toBe('toString');
    expect(t('{constructor}')).toBe('{constructor}');
  });
  it('uses the correct zero, one and multiple forms', () => {
    for (const count of [0, 1, 2]) {
      expect(plural('{count} warning', '{count} warnings', count)).toBe(`${count} warning${count === 1 ? '' : 's'}`);
    }
    setLanguage('fr');
    for (const count of [0, 1, 2]) {
      expect(plural('{count} warning', '{count} warnings', count)).toBe(`${count} avertissement${count < 2 ? '' : 's'}`);
    }
  });
  it('preserves precision and keeps French units with their number', () => {
    expect(formatQuantity(1.01, 'kW/m²', 2)).toBe('1.01 kW/m²');
    setLanguage('fr');
    expect(formatNumber(1.01, 2)).toBe('1,01');
    expect(formatQuantity(1.01, 'kW/m²', 2)).toBe('1,01\u202fkW/m²');
    expect(formatQuantity(2, '%', 1)).toBe('2,0\u202f%');
    expect(formatLength(1.25, 'm', { fixed: true })).toBe('1,250');
    expect(parseLength('1,250', 'm')).toBe(1.25);
    expect(parseLength('1.250', 'm')).toBe(1.25);
  });
  it('notifies on changes and can unsubscribe', () => {
    const changed = vi.fn();
    const off = subscribeLanguage(changed);
    setLanguage('fr'); setLanguage('fr');
    expect(language()).toBe('fr');
    expect(changed).toHaveBeenCalledTimes(1);
    off(); setLanguage('en');
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('has a French entry for every static source key and rejects dynamic keys', () => {
    const collected = collectKeys(resolve('src'));
    expect(collected.errors).toEqual([]);
    expect(collected.keys.length).toBeGreaterThan(900);
    expect(collected.keys.filter(key => fr[key] === undefined)).toEqual([]);
    for (const key of collected.keys) {
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
      expect(placeholders(fr[key]), key).toEqual(placeholders(key));
    }
  });
  it('collects aliases, namespace calls, templates and both plural keys, and rejects hidden calls', () => {
    const collected = collectKeys(resolve('scripts/fixtures'));
    expect(collected.keys).toEqual(['double', 'first', 'many', 'one', 'others', 'single', 'template']);
    expect(collected.errors).toHaveLength(4);
  });
  it('covers every shipped camera note without changing custom notes', () => {
    for (const preset of BUILTIN_CAMERA_PRESETS) expect(presetNote(preset)).toBe(preset.note);
    setLanguage('fr');
    for (const preset of BUILTIN_CAMERA_PRESETS) expect(presetNote(preset)).not.toBe(preset.note);
    const custom = { ...BUILTIN_CAMERA_PRESETS[0], id: 'custom', note: 'My camera 1.01' };
    expect(presetNote(custom)).toBe(custom.note);
  });
  it('changes diagnostics and printed output while preserving plan, FDS and CSV bytes', () => {
    const doc = newPlan('My fire 1.01');
    doc.objects.push(createBurner(doc, [0, 0, 0]), createThermocouple(doc));
    const english = [serializePlan(doc), devicesToFds(doc), instrumentScheduleCsv(doc, 'm')];
    expect(checkPlan(newPlan()).some(i => i.message === 'Plan has no burner; flame geometry is undefined.')).toBe(true);
    setLanguage('fr');
    expect([serializePlan(doc), devicesToFds(doc), instrumentScheduleCsv(doc, 'm')]).toEqual(english);
    expect(checkPlan(newPlan()).some(i => i.message === 'Le plan ne contient aucun brûleur; la géométrie de flamme est indéfinie.')).toBe(true);
    const report = buildReportHtml(doc, 'm');
    expect(report).toContain('lang="fr"');
    expect(report).toContain('Tableau d’implantation');
    expect(report).toContain('My fire 1.01');
  });
  it('keeps imported provenance, source names and stored link kinds in English', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const source = readFileSync(resolve('../fixtures/fds/room_corner.fds'), 'utf8');
      const english = fdsToPlan(source);
      setLanguage('fr');
      const french = fdsToPlan(source);
      expect(serializePlan(french.doc)).toBe(serializePlan(english.doc));
      expect(french.issues.map(i => i.code)).toEqual(english.issues.map(i => i.code));
      expect(french.issues.map(i => i.message)).not.toEqual(english.issues.map(i => i.message));
      expect(linkKindFor('camera')).toBe('video');
      expect(linkKindFor('burner')).toBe('spreadsheet');
    } finally { vi.useRealTimers(); }
  });
});
