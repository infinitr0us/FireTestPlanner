import { language, setLanguage, type Language } from './i18n';

const KEY = 'fire-test-plan.language';
let saveRemote: ((value: Language) => Promise<boolean>) | null = null;
let remote = false;
let revision = 0;
let writes: Promise<unknown> = Promise.resolve();

export function restoreBrowserLanguage(): void {
  try { setLanguage(localStorage.getItem(KEY) === 'fr' ? 'fr' : 'en'); }
  catch { /* The language still works for this session when storage is unavailable. */ }
}
export function chooseLanguage(value: Language): void {
  revision++;
  setLanguage(value);
  if (remote) {
    const save = saveRemote;
    if (save) writes = writes.then(() => save(value)).catch(() => false);
  } else {
    try { localStorage.setItem(KEY, value); } catch { /* Session-only preference. */ }
  }
}
export async function adoptShellLanguage(
  load: () => Promise<unknown>, save: (value: Language) => Promise<boolean>,
): Promise<void> {
  remote = true;
  saveRemote = save;
  const before = revision;
  try {
    const value = await load();
    if (revision === before) setLanguage(value === 'fr' ? 'fr' : 'en');
    else await (writes = writes.then(() => save(language())).catch(() => false));
  } catch { /* Keep the current language; never fall back to the shell's transient origin. */ }
}
