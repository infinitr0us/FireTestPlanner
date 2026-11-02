import { h } from './dom';

/** APG action menu. Native buttons retain Enter/Space; navigation stays local. */
export function menuButton(label: string, id: string, items: HTMLElement[]): HTMLElement {
  const menu = h('div', { id, class: 'toolbar-menu__items', role: 'menu', hidden: true,
    'aria-labelledby': `${id}-button` }, items);
  const close = (focus = false): void => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (focus) trigger.focus();
  };
  const open = (last = false): void => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    items[last ? items.length - 1 : 0].focus();
    document.addEventListener('pointerdown', outside, true);
  };
  const trigger = h('button', { type: 'button', id: `${id}-button`, class: 'toolbar__btn',
    'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id,
    onclick: () => menu.hidden ? open() : close(true),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation(); open(e.key === 'ArrowUp');
      }
    },
  }, [label, h('span', { 'aria-hidden': 'true' }, [' ▾'])]);
  const root = h('div', { class: 'toolbar-menu' }, [trigger, menu]);
  const outside = (e: PointerEvent): void => { if (!root.contains(e.target as Node)) close(); };
  for (const item of items) {
    item.setAttribute('role', 'menuitem'); item.tabIndex = -1;
    // Close before an action opens its dialog, so the dialog restores the trigger.
    item.addEventListener('click', () => close(true), { capture: true });
  }
  menu.addEventListener('keydown', e => {
    e.stopPropagation();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(true); // native Tab continues from the trigger
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  });
  root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget as Node)) close(); });
  return root;
}
