import { h } from './dom';

const controls = {
  first: ['⏮', 'First frame (Home)'],
  previous: ['◀', 'Previous frame (,)'],
  play: ['▶', 'Play (Space)'],
  next: ['▶|', 'Next frame (.)'],
  last: ['⏭', 'Last frame (End)'],
} as const;
type TransportAction = keyof typeof controls;
export type TransportCommands = Record<TransportAction, () => void>;

/** Shared affordances; each workspace retains its own clock and loading policy. */
export function transportButton(action: TransportAction, onclick: () => void): HTMLButtonElement {
  const [glyph, label] = controls[action];
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
  const label = playing ? 'Pause (Space)' : 'Play (Space)';
  button.title = label;
  button.setAttribute('aria-label', label);
}

/** Form controls retain their native keys. Only the frame scrubber borrows
 * Space/comma/period; Home/End and arrows still produce native input events. */
export function handleTransportKey(
  e: KeyboardEvent,
  commands: TransportCommands,
  frameSlider?: HTMLInputElement
): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target instanceof HTMLElement ? e.target : null;
  const isFrameSlider = target === frameSlider;
  if (target?.isContentEditable) return false;
  if (target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName) && !isFrameSlider) return false;
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
