/** Form controls for the inspector. Every length control is unit-aware: it displays
 *  in the user's chosen unit and accepts an explicit suffix regardless. */

import { formatLength, parseLength } from '../core/units';
import type { LengthUnit } from '../core/types';
import { h } from './dom';

export function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label', title: hint ?? '' }, [label]),
    control,
  ]);
}

export function sectionTitle(text: string): HTMLElement {
  return h('h3', { class: 'panel__section' }, [text]);
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
    type: 'number',
    value: String(Number(value.toFixed(4))),
    step: opts.step ?? 0.1,
    min: opts.min,
    max: opts.max,
    onchange: (e: Event) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) onChange(v);
    },
  });
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
    inputMode: 'decimal',
    value: formatLength(metres, unit),
    title: `In ${unit}. An explicit suffix wins: 9ft, 250mm, 5' 6"`,
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

export function readout(label: string, value: string, tone?: 'good' | 'bad' | 'muted'): HTMLElement {
  return h('div', { class: `readout${tone ? ` readout--${tone}` : ''}` }, [
    h('span', { class: 'readout__label' }, [label]),
    h('span', { class: 'readout__value' }, [value]),
  ]);
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`.trim(), type: 'button', onclick: onClick }, [label]);
}
