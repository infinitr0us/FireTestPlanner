import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('restores and saves browser language and tolerates unavailable storage', async () => {
  vi.resetModules();
  const storage = { getItem: vi.fn(() => 'fr'), setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  const preference = await import('./language-preference');
  const i18n = await import('./i18n');
  preference.restoreBrowserLanguage();
  expect(i18n.language()).toBe('fr');
  preference.chooseLanguage('en');
  expect(storage.setItem).toHaveBeenCalledWith('fire-test-plan.language', 'en');
  storage.getItem.mockImplementation(() => { throw Error('disabled'); });
  storage.setItem.mockImplementation(() => { throw Error('disabled'); });
  expect(() => preference.restoreBrowserLanguage()).not.toThrow();
  expect(() => preference.chooseLanguage('fr')).not.toThrow();
  expect(i18n.language()).toBe('fr');
});

it('loads shell settings and serializes choices made during a delayed load', async () => {
  vi.resetModules();
  const storage = { setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  const preference = await import('./language-preference');
  const i18n = await import('./i18n');
  let loaded!: (value: string) => void;
  const saved: string[] = [];
  const pending = preference.adoptShellLanguage(() => new Promise(resolve => { loaded = resolve; }), async value => {
    saved.push(value); return true;
  });
  preference.chooseLanguage('fr');
  preference.chooseLanguage('en');
  loaded('fr');
  await pending;
  expect(i18n.language()).toBe('en');
  expect(saved).toEqual(['fr', 'en', 'en']);
  expect(storage.setItem).not.toHaveBeenCalled();
  await preference.adoptShellLanguage(async () => 'fr', async () => true);
  expect(i18n.language()).toBe('fr');
});
