/** Display-only wrappers. File writers continue importing core/units directly. */
export * from '../core/units';
import { formatLength as rawLength, formatLengthWithUnit as rawWithUnit, parseLength as rawParseLength } from '../core/units';
import { language, numberText } from './i18n';

export const formatLength: typeof rawLength = (...args) => numberText(rawLength(...args));
export const formatLengthWithUnit: typeof rawWithUnit = (...args) => {
  const text = numberText(rawWithUnit(...args));
  return language() === 'fr' ? text.replace(/ (?=(?:m|cm|mm|ft|in)$)/, '\u202f') : text;
};
export const parseLength: typeof rawParseLength = (text, unit) => rawParseLength(
  language() === 'fr' && !text.includes('.') ? text.replace(/(\d),(?=\d)/g, '$1.') : text, unit,
);
