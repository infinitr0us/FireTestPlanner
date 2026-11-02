import * as i18n from './i18n';
/** Form controls for the inspector. Every length control is unit-aware: it displays
 *  in the user's chosen unit and accepts an explicit suffix regardless. */

import { formatLength, parseLength } from './display-units';
import type { LengthUnit } from '../core/types';
import { h } from './dom';

export function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  // A wrapping label names only its first input. Give every vector component a
  // distinct name, retaining the visible row label and component/axis text.
  const fields = control.matches('input, select, textarea') ? [control]
    : [...control.querySelectorAll<HTMLElement>('input, select, textarea')];
  for (const field of fields) {
    if (!field.hasAttribute('aria-label')) {
      const axis = field.closest('.field__vec-cell')?.querySelector('.field__vec-axis')?.textContent;
      field.setAttribute('aria-label', axis ? i18n.t('{label}: {axis}', { label, axis }) : label);
    }
  }
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label', title: hint ?? '' }, [label]),
    control,
  ]);
}

/** A section heading, optionally with a control on the right -- for a switch that
 *  changes what the whole section means rather than one value inside it. */
export function sectionTitle(text: string, aside?: HTMLElement): HTMLElement {
  return h('h3', { class: 'panel__section' }, aside ? [text, aside] : [text]);
}

export function textField(value: string, onChange: (v: string) => void): HTMLInputElement {
  return h('input', {
    class: 'field__input',
    type: 'text',
    value,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).value),
  });
}

export function numberField(
  value: number,
  onChange: (v: number) => void,
  opts: { step?: number; min?: number; max?: number } = {},
): HTMLInputElement {
  return h('input', {
    class: 'field__input',
    type: 'text',
    inputMode: 'decimal',
    value: i18n.numberText(Number(value.toFixed(4))),
    step: opts.step ?? 0.1,
    min: opts.min,
    max: opts.max,
    onchange: (e: Event) => {
      const text = (e.target as HTMLInputElement).value.trim();
      const v = text === '' ? NaN : Number(text.replace(',', '.'));
      if (Number.isFinite(v)) onChange(v);
    },
  });
}

/** An absent measurement is not a measured zero. Clearing preserves null. */
export function optionalNumberField(value: number | null | undefined, onChange: (v: number | null) => void,
  opts: { step?: number; min?: number; max?: number } = {}): HTMLInputElement {
  const input = numberField(value ?? 0, onChange, opts);
  input.value = value == null ? '' : input.value;
  input.placeholder = i18n.t('not set');
  input.addEventListener('change', () => { if (!input.value.trim()) onChange(null); });
  return input;
}

/**
 * A length in the active display unit.
 *
 * Text rather than number input on purpose: it lets someone working in metres type
 * `9ft`, or `5' 6"`, into any field without switching modes.
 */
export function lengthField(
  metres: number,
  unit: LengthUnit,
  onChange: (metres: number) => void,
): HTMLInputElement {
  const input = h('input', {
    class: 'field__input',
    type: 'text',
    inputMode: unit === 'ft-in' ? 'text' : 'decimal',
    value: formatLength(metres, unit),
    title: i18n.t("In {p1}. An explicit suffix wins: 9ft, 250mm, 5' 6 1/2\"", { p1: unit === 'ft-in' ? i18n.t("feet and inches (bare numbers are feet)") : unit }),
  });
  input.addEventListener('change', () => {
    const parsed = parseLength(input.value, unit);
    if (parsed === null) {
      input.value = formatLength(metres, unit); // reject silently rather than store NaN
      input.classList.add('field__input--rejected');
      setTimeout(() => input.classList.remove('field__input--rejected'), 600);
      return;
    }
    onChange(parsed);
  });
  return input;
}

export function vecField(
  values: number[],
  unit: LengthUnit,
  labels: string[],
  onChange: (index: number, metres: number) => void,
): HTMLElement {
  return h(
    'div',
    { class: 'field__vec' },
    values.map((v, i) =>
      h('span', { class: 'field__vec-cell' }, [
        h('span', { class: 'field__vec-axis' }, [labels[i]]),
        lengthField(v, unit, (m) => onChange(i, m)),
      ]),
    ),
  );
}

export function selectField<T extends string>(
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (v: T) => void,
): HTMLSelectElement {
  return h(
    'select',
    {
      class: 'field__input',
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T),
    },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, [o.label])),
  );
}

export function checkboxField(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h('input', {
    class: 'field__checkbox',
    type: 'checkbox',
    checked: value,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
}

export type ReadoutTone = 'good' | 'warn' | 'bad' | 'muted';

export function readout(label: string, value: string, tone?: ReadoutTone): HTMLElement {
  return h('div', { class: `readout${tone ? ` readout--${tone}` : ''}` }, [
    h('span', { class: 'readout__label' }, [label]),
    h('span', { class: 'readout__value' }, [value]),
  ]);
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`.trim(), type: 'button', onclick: onClick }, [label]);
}
