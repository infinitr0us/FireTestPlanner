import * as i18n from './i18n';
import { h } from './dom';

const controls = () => ({
  first: ['⏮\uFE0E', i18n.t("First frame (Home)")],
  previous: ['◀', i18n.t("Previous frame (,)")],
  play: ['▶', i18n.t("Play (Space)")],
  next: ['▶|', i18n.t("Next frame (.)")],
  last: ['⏭\uFE0E', i18n.t("Last frame (End)")],
} as const);
type TransportAction = keyof ReturnType<typeof controls>;
export type TransportCommands = Record<TransportAction, () => void>;

/** Shared affordances; each workspace retains its own clock and loading policy. */
export function transportButton(action: TransportAction, onclick: () => void): HTMLButtonElement {
  const [glyph, label] = controls()[action];
  return h(
    'button',
    {
      type: 'button',
      class: 'playback-bar__btn',
      title: label,
      'aria-label': label,
      onclick,
    },
    [glyph]
  );
}

export function setTransportPlaying(button: HTMLButtonElement, playing: boolean): void {
  button.textContent = playing ? '❚❚' : '▶';
  const label = playing ? i18n.t("Pause (Space)") : i18n.t("Play (Space)");
  button.title = label;
  button.setAttribute('aria-label', label);
}

/** Editable controls retain native keys; buttons, links and disclosure summaries
 * retain Space. Only the frame scrubber borrows Space/comma/period; Home/End and
 * arrows still produce native input events. Step/jump keys work from buttons. */
export function handleTransportKey(
  e: KeyboardEvent,
  commands: TransportCommands,
  frameSlider?: HTMLInputElement
): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  // Read only the element capabilities we need, including descendants of buttons.
  // This also allows the key policy to run in Node without a DOM constructor.
  const target = e.target as (Element & { isContentEditable?: boolean }) | null;
  const control = target?.closest?.('input, select, textarea, button, summary, a, [role]') ?? target;
  const isFrameSlider = target === frameSlider;
  if (target?.isContentEditable) return false;
  if (control && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) && !isFrameSlider) return false;
  if (e.key === ' ' && !isFrameSlider && control &&
      (/^(BUTTON|SUMMARY|A)$/.test(control.tagName) || control.hasAttribute?.('role') ||
       (control.hasAttribute?.('tabindex') && control.tagName !== 'CANVAS'))) return false;
  const action = (
    {
      ' ': 'play',
      ',': 'previous',
      '.': 'next',
      Home: 'first',
      End: 'last',
    } as const
  )[e.key as ' ' | ',' | '.' | 'Home' | 'End'];
  if (!action || (isFrameSlider && (action === 'first' || action === 'last'))) return false;
  e.preventDefault();
  e.stopPropagation();
  // Holding Space should not flicker between playing and paused.
  if (!(action === 'play' && e.repeat)) commands[action]();
  return true;
}
