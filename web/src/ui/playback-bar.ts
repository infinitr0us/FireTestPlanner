/**
 * The playback bar: transport, scrubber and readout for the reconstructed flames,
 * docked along the bottom of the viewport whenever the plan holds one.
 *
 * Smokeview's time bar is the model: `t = 55.0 s` is the primary readout and the
 * frame index is secondary, because the engineers think in test seconds. The
 * scrubber snaps to the clock's marks -- the union of every loaded sequence's
 * timestamps -- and ParaView's "snap to timesteps" is the transport model: time
 * runs in seconds at a real-time multiple, and a frame holds until the next.
 */

import { fileName } from '../core/linked-files';
import { shell } from '../io/files';
import { flameSequenceLink, reconstructedFlames } from '../core/plan';
import type { ReconstructedFlameObject } from '../core/types';
import type { FlameStore } from '../state/flame-store';
import { SPEEDS, type Playhead } from '../state/playhead';
import type { Store } from '../state/store';
import { h } from './dom';
import { handleTransportKey, setTransportPlaying, transportButton } from './transport';

export interface PlaybackBarHost {
  /** Cubes on screen this instant, for the readout. */
  cubeCount: () => number;
  /** Render the viewport at figure resolution and hand the PNG to the browser. */
  snapshot: () => void;
  /** Ask the shell or the page to (re)read a flame's frames; null where it cannot. */
  loadFrames: ((flame: ReconstructedFlameObject) => void) | null;
}

const formatTime = (t: number): string => `${t.toFixed(1)} s`;

export class PlaybackBar {
  private root = h('section', { class: 'playback-bar', hidden: true, 'aria-label': 'Flame playback' });
  private signature = '';
  private slider: HTMLInputElement | null = null;
  private readout: HTMLElement | null = null;
  private playButton: HTMLButtonElement | null = null;

  constructor(
    container: HTMLElement,
    private store: Store,
    private flames: FlameStore,
    private playhead: Playhead,
    private host: PlaybackBarHost,
  ) {
    container.append(this.root);
    // The bar sits over the canvas; a click on it must not select, place or measure.
    // Keys are not stopped: the editor's shortcuts are handled on the window, which
    // takes Ctrl+S and the like from these controls and leaves them the rest, and
    // stopping them here only handed Ctrl+S to the browser.
    for (const event of ['pointerdown', 'click', 'dblclick', 'wheel']) {
      this.root.addEventListener(event, (e) => e.stopPropagation());
    }
    store.subscribe(() => this.render());
    flames.subscribe(() => this.render());
    playhead.subscribe((event) => (event === 'time' ? this.update() : this.render()));
    this.render();
  }

  get visible(): boolean { return !this.root.hidden; }

  /** The bar's element, for whoever has to make room for it. */
  get element(): HTMLElement { return this.root; }

  /** Rebuild the controls. Cheap, but it drops focus, so time changes go to `update`. */
  render(): void {
    const doc = this.store.document;
    const flames = reconstructedFlames(doc);
    this.root.hidden = flames.length === 0;
    if (!flames.length) { this.signature = ''; return; }

    const marks = this.playhead.marks;
    const status = flames.map((f) => this.statusOf(f));
    // Play/pause, speed and loop are not in the signature: they change through the
    // bar's own controls, `update` keeps the play button's label right, and a
    // rebuild on every press would drop the keyboard focus from the button pressed.
    const signature = JSON.stringify([
      this.store.documentId, flames.map((f) => [f.id, f.name, f.display?.visible]), status,
      marks.length, this.playhead.start, this.playhead.end,
    ]);
    if (signature === this.signature) { this.update(); return; }
    this.signature = signature;

    const ready = marks.length > 0;
    const button = (label: string, title: string, onclick: () => void, disabled = !ready): HTMLButtonElement => {
      const b = h('button', { type: 'button', class: 'playback-bar__btn', title, onclick }, [label]);
      b.disabled = disabled;
      return b;
    };
    const transport = (action: Parameters<typeof transportButton>[0], onclick: () => void) => {
      const b = transportButton(action, onclick);
      b.disabled = !ready;
      return b;
    };
    this.playButton = transport('play', () => this.playhead.toggle());
    this.slider = h('input', {
      type: 'range', class: 'playback-bar__slider', min: 0, max: Math.max(marks.length - 1, 0), step: 1,
      value: Math.max(this.playhead.markIndexAt(this.playhead.time_s), 0), 'aria-label': 'Frame',
      oninput: (e: Event) => {
        const index = Number((e.target as HTMLInputElement).value);
        if (marks[index] !== undefined) this.playhead.seek(marks[index]);
      },
      // The scrubber keeps the focus after a drag, and the window's shortcuts leave
      // a form control's keys to it. Space, ',' and '.' are the transport's here: a
      // slider has no use for them, and whoever has just scrubbed expects Space to
      // play. Home, End and the arrows are the slider's own, and seek through `input`.
      onkeydown: (e: KeyboardEvent) => handleTransportKey(e, {
        play: () => this.playhead.toggle(),
        previous: () => this.playhead.step(-1),
        next: () => this.playhead.step(1),
        first: () => this.playhead.seek(this.playhead.start),
        last: () => this.playhead.seek(this.playhead.end),
      }, this.slider ?? undefined),
    }) as HTMLInputElement;
    this.slider.disabled = !ready;
    this.readout = h('output', { class: 'playback-bar__readout', 'aria-live': 'off' });

    const speed = h('select', { class: 'playback-bar__select', title: 'Playback speed, times real time', 'aria-label': 'Playback speed',
      onchange: (e: Event) => this.playhead.setSpeed(Number((e.target as HTMLSelectElement).value)) },
    SPEEDS.map((s) => h('option', { value: s, selected: s === this.playhead.speed }, [`×${s}`])));
    const loop = h('label', { class: 'playback-bar__loop', title: 'Start over at the end' }, [
      h('input', { type: 'checkbox', checked: this.playhead.loop, onchange: (e: Event) => this.playhead.setLoop((e.target as HTMLInputElement).checked) }),
      'Loop',
    ]);
    const legend = h('span', { class: 'playback-bar__legend', title: 'Height ramp: blue at the base, red at the tip, on a fixed scale over the whole sequence' }, [
      h('span', { class: 'playback-bar__ramp' }), 'base → tip',
    ]);
    const snapshot = button('PNG', 'Save the viewport at 3× resolution, for a figure', () => this.host.snapshot(), false);

    const controls = h('div', { class: 'playback-bar__controls' }, [
      transport('first', () => this.playhead.seek(this.playhead.start)),
      transport('previous', () => this.playhead.step(-1)),
      this.playButton,
      transport('next', () => this.playhead.step(1)),
      transport('last', () => this.playhead.seek(this.playhead.end)),
      this.slider,
      this.readout,
      speed,
      loop,
      legend,
      snapshot,
    ]);

    const lines = flames.map((f, i) => this.statusLine(f, status[i])).filter((line): line is HTMLElement => line !== null);
    this.root.replaceChildren(controls, ...lines);
    this.update();
  }

  /** Time moved: the slider and the readout, nothing else. */
  private update(): void {
    if (this.root.hidden || !this.slider || !this.readout) return;
    const marks = this.playhead.marks;
    const index = this.playhead.markIndexAt(this.playhead.time_s);
    if (marks.length) this.slider.value = String(Math.max(index, 0));
    const cubes = this.host.cubeCount();
    this.readout.textContent = marks.length
      ? `t = ${formatTime(this.playhead.time_s)} · frame ${Math.max(index, 0) + 1}/${marks.length} · ${cubes.toLocaleString()} cubes`
      : 'no frames loaded';
    if (this.playButton) setTransportPlaying(this.playButton, this.playhead.playing);
  }

  private statusOf(flame: ReconstructedFlameObject): string {
    const link = flameSequenceLink(flame);
    if (!link) return 'unlinked';
    const entry = this.flames.get(link);
    if (!entry) return 'absent';
    if (entry.status === 'loading') return `loading ${entry.progress.done}/${entry.progress.total}`;
    if (entry.status === 'error') return `error ${entry.error}`;
    return entry.changed ? `changed ${entry.changed}` : 'ready';
  }

  private statusLine(flame: ReconstructedFlameObject, status: string): HTMLElement | null {
    const link = flameSequenceLink(flame);
    const name = flame.name || flame.id;
    const line = (text: string, kind: 'info' | 'warn' | 'error', action?: HTMLElement): HTMLElement =>
      h('div', { class: `playback-bar__status playback-bar__status--${kind}`, role: kind === 'info' ? undefined : 'status' }, [text, action ?? null]);
    // Unlinked first: nothing below has a link to ask the cache about, and this
    // runs inside the document event that removes the link.
    if (!link) return line(`${name}: no voxel folder linked. Link one in the inspector.`, 'warn');
    const load = this.host.loadFrames
      ? h('button', { type: 'button', class: 'playback-bar__btn', onclick: () => this.host.loadFrames!(flame) },
        [status.startsWith('error') ? 'Try again' : 'Load frames…'])
      : null;
    if (status === 'absent') {
      return line(`${name}: ${link.sequence?.frames.length ?? 0} frames in ${fileName(link.path)} are not loaded.`, 'info', load ?? undefined);
    }
    if (status.startsWith('loading')) return line(`${name}: reading frame ${status.slice(8)} from ${fileName(link.path)}…`, 'info');
    if (status.startsWith('error')) return line(`${name}: ${status.slice(6)}`, 'error', load ?? undefined);
    if (status.startsWith('changed')) {
      return line(`${name}: ${status.slice(8)}. ${shell() ? 'Refresh' : 'Relink'} the link in the inspector to adopt the folder as it is now.`, 'warn');
    }
    return null;
  }
}
