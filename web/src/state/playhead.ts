/**
 * The playback clock: one time for every recorded thing on screen.
 *
 * Session state, deliberately outside the Store. It is not undoable, it is not in
 * the file, and it changes sixty times a second while playing -- the reasoning
 * behind `setDisplayUnit` not being an edit, taken further. It has its own
 * subscription because the store's listeners rebuild the toolbar and the scene on
 * every event they do not recognise, and a clock tick must do neither.
 *
 * Followers map `time_s` to their own samples independently -- the flame to the
 * last frame at or before it, the volume plot to the last sample at or before it --
 * and neither imports the other. A linked video would be a third follower.
 */

export type PlayheadEvent = 'time' | 'state' | 'range';
type Listener = (event: PlayheadEvent) => void;

/** Real-time multipliers the bar offers. x1 is one 5 s frame every 5 s. */
export const SPEEDS = [1, 2, 5, 10, 30, 60] as const;
export const DEFAULT_SPEED = 10;

export class Playhead {
  private listeners = new Set<Listener>();
  private _time = 0;
  private _playing = false;
  private _speed: number = DEFAULT_SPEED;
  private _loop = true;
  /** Every instant a follower has a sample at, sorted and unique. */
  private _marks: number[] = [];

  get time_s(): number { return this._time; }
  get playing(): boolean { return this._playing; }
  get speed(): number { return this._speed; }
  get loop(): boolean { return this._loop; }
  get marks(): readonly number[] { return this._marks; }
  get start(): number { return this._marks.length ? this._marks[0] : 0; }
  get end(): number { return this._marks.length ? this._marks[this._marks.length - 1] : 0; }
  get hasRange(): boolean { return this._marks.length > 0; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: PlayheadEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /**
   * Replace the set of instants the followers have samples at.
   *
   * The union of every loaded sequence's timestamps: stepping visits each of them,
   * the scrubber snaps to them, and playback runs from the first to the last. The
   * current time is kept where it is unless it has fallen outside the new range.
   */
  setMarks(marks: Iterable<number>): void {
    const next = [...new Set(marks)].filter(Number.isFinite).sort((a, b) => a - b);
    if (next.length === this._marks.length && next.every((t, i) => t === this._marks[i])) return;
    this._marks = next;
    if (!next.length) this.pause();
    else if (this._time < this.start || this._time > this.end) this._time = this.start;
    this.emit('range');
  }

  /** Index of the last mark at or before `t`, or -1 before the first. */
  markIndexAt(t: number): number {
    let lo = 0, hi = this._marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._marks[mid] <= t) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  seek(t: number): void {
    if (!Number.isFinite(t)) return;
    const clamped = this.hasRange ? Math.min(Math.max(t, this.start), this.end) : t;
    if (clamped === this._time) return;
    this._time = clamped;
    this.emit('time');
  }

  /** Move to the previous or next mark; from between two marks, `step(-1)` goes to
   *  the one before the current interval, not to its start. */
  step(direction: 1 | -1): void {
    if (!this.hasRange) return;
    const at = this.markIndexAt(this._time);
    const next = direction > 0 ? Math.min(at + 1, this._marks.length - 1) : Math.max(at - 1, 0);
    this.seek(this._marks[next]);
  }

  play(): void {
    if (this._playing || !this.hasRange) return;
    // Pressing play at the end starts over; a bar that did nothing there reads as broken.
    if (this._time >= this.end) this._time = this.start;
    this._playing = true;
    this.emit('state');
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    this.emit('state');
  }

  toggle(): void {
    if (this._playing) this.pause(); else this.play();
  }

  setSpeed(speed: number): void {
    if (!(speed > 0) || speed === this._speed) return;
    this._speed = speed;
    this.emit('state');
  }

  setLoop(loop: boolean): void {
    if (loop === this._loop) return;
    this._loop = loop;
    this.emit('state');
  }

  /**
   * Advance by `elapsed_s` of wall-clock time. Called from the render loop; a
   * no-op while paused, so calling it every frame costs nothing.
   */
  advance(elapsed_s: number): void {
    if (!this._playing || !(elapsed_s > 0)) return;
    let t = this._time + elapsed_s * this._speed;
    if (t > this.end) {
      const span = this.end - this.start;
      if (this._loop) t = span > 0 ? this.start + ((t - this.start) % span) : this.start;
      else { t = this.end; this._playing = false; this.emit('state'); }
    }
    this._time = t;
    this.emit('time');
  }
}
