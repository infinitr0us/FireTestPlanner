/** DOM-free gettext-style messages. Core defaults to English until the UI opts in. */
import { fr } from './i18n-fr';

export type Language = 'en' | 'fr';
export type Params = Readonly<Record<string, string | number | undefined | null>>;
let current: Language = 'en';
const listeners = new Set<() => void>();
const warned = new Set<string>();

export const language = (): Language => current;
export const unitSpace = (english = ' '): string => current === 'fr' ? '\u202f' : english;
export function setLanguage(value: Language): void {
  if (value !== 'en' && value !== 'fr') return;
  if (value === current) return;
  current = value;
  listeners.forEach(listener => listener());
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Keep the caller's precision, including trailing zeros, without grouping. */
export function numberText(value: number | string): string {
  const text = String(value);
  return current === 'fr' ? text.replace(/(?<=\d)\.(?=\d)/g, ',') : text;
}
export function formatNumber(value: number, digits?: number): string {
  return numberText(digits === undefined ? value : value.toFixed(digits));
}
export function formatQuantity(value: number, unit: string, digits?: number): string {
  return `${formatNumber(value, digits)}${current === 'fr' ? '\u202f' : ' '}${unit}`;
}

export function t(text: string, params: Params = {}): string {
  let message = text;
  if (current === 'fr') {
    const translated = Object.prototype.hasOwnProperty.call(fr, text) ? fr[text] : undefined;
    if (translated !== undefined) message = translated;
    else if (import.meta.env.DEV && !warned.has(text)) {
      warned.add(text);
      console.warn(`[i18n] Missing French translation: ${text}`);
    }
  }
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined;
    return value === undefined ? match : typeof value === 'number' ? numberText(value) : String(value);
  });
}

/** French uses the singular for zero and one, including their decimal intervals. */
export function plural(one: string, other: string, count: number, params: Params = {}): string {
  const singular = current === 'fr' ? count >= 0 && count < 2 : count === 1;
  return t(singular ? one : other, { ...params, count });
}
