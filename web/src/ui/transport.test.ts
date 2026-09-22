import { describe, expect, it, vi } from 'vitest';
import { handleTransportKey, type TransportCommands } from './transport';

const target = (tagName: string, extra = {}) => ({ tagName, ...extra }) as unknown as HTMLInputElement;
const event = (key: string, target: EventTarget | null, extra = {}) => ({
  key, target, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false,
  repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
}) as unknown as KeyboardEvent;
const commands = (): TransportCommands => ({
  play: vi.fn(), previous: vi.fn(), next: vi.fn(), first: vi.fn(), last: vi.fn(),
});
const keys = [' ', ',', '.', 'Home', 'End'];

describe('shared transport keyboard policy', () => {
  it.each(['INPUT', 'SELECT', 'TEXTAREA', 'DIV'])('preserves editing keys on %s', tag => {
    const c = commands();
    for (const key of keys) {
      const e = event(key, target(tag, { isContentEditable: tag === 'DIV' }));
      expect(handleTransportKey(e, c)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(c)) expect(fn).not.toHaveBeenCalled();
  });
  it.each(['BUTTON', 'SUMMARY', 'A'])('leaves Space activation to %s', tag => {
    const c = commands(), e = event(' ', target(tag));
    expect(handleTransportKey(e, c)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(c.play).not.toHaveBeenCalled();
  });
  it('leaves Space to an interactive ancestor or custom focus target', () => {
    const button = target('BUTTON');
    for (const t of [target('SPAN', { closest: () => button }),
      target('DIV', { hasAttribute: (name: string) => name === 'role' }),
      target('DIV', { hasAttribute: (name: string) => name === 'tabindex' })]) {
      expect(handleTransportKey(event(' ', t), commands())).toBe(false);
    }
  });
  it('steps and jumps with a transport button still focused after a click', () => {
    const c = commands();
    for (const key of keys.slice(1)) expect(handleTransportKey(event(key, target('BUTTON')), c)).toBe(true);
    for (const action of ['previous', 'next', 'first', 'last'] as const) expect(c[action]).toHaveBeenCalledOnce();
    expect(c.play).not.toHaveBeenCalled();
  });
  it('borrows only Space and stepping keys from the frame slider', () => {
    const slider = target('INPUT'), c = commands();
    for (const key of [' ', ',', '.']) expect(handleTransportKey(event(key, slider), c, slider)).toBe(true);
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
      const e = event(key, slider);
      expect(handleTransportKey(e, c, slider)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(c.play).toHaveBeenCalledOnce();
    expect(c.previous).toHaveBeenCalledOnce();
    expect(c.next).toHaveBeenCalledOnce();
  });
  it('consumes held Space without repeatedly toggling playback', () => {
    const c = commands(), canvas = target('CANVAS');
    handleTransportKey(event(' ', canvas), c);
    const repeated = event(' ', canvas, { repeat: true });
    expect(handleTransportKey(repeated, c)).toBe(true);
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(c.play).toHaveBeenCalledOnce();
  });
  it.each(['ctrlKey', 'metaKey', 'altKey', 'defaultPrevented'])('does not take shortcuts with %s', modifier => {
    const c = commands(), e = event('.', target('CANVAS'), { [modifier]: true });
    expect(handleTransportKey(e, c)).toBe(false);
    expect(c.next).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
