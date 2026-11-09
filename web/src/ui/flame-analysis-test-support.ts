// Small DOM/WebCodecs test doubles. These exercise ownership and handlers, not
// browser layout, native focus navigation, GPU rendering or real codec support.
import { vi } from 'vitest';

export function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

export function fakeDocument() {
  const all: any[] = [];
  const doc: any = { activeElement: null };
  class Element {
    [key: string]: any;
    children: any[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    style = { setProperty: vi.fn() };
    value = ''; text = ''; className = ''; title = ''; open = false; inert = false;
    selected = false; disabled = false; hidden = false; tabIndex = 0; width = 0; height = 0;
    parentElement: Element | null = null;
    classList = { remove: vi.fn(), toggle: vi.fn(), add: vi.fn() };
    context: any = { canvas: this, drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn() };
    constructor(readonly tagName: string) { all.push(this); }
    set textContent(value: string) { this.text = value; this.children = []; }
    get textContent(): string { return this.text + this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
    setAttribute(k: string, v: string) { this.attributes[k] = v; }
    getAttribute(k: string) { return this.attributes[k] ?? null; }
    addEventListener(name: string, cb: any) { this['on' + name] = cb; }
    append(...children: any[]) {
      for (const c of children) { this.children.push(c); if (typeof c !== 'string') c.parentElement = this; }
      if (this.tagName === 'SELECT') this.value = (this.children.find((c) => c.selected) ?? this.children[0])?.value ?? '';
    }
    replaceChildren(...children: any[]) { this.children = []; this.append(...children); }
    contains(node: any): boolean { return this === node || this.children.some((c) => typeof c !== 'string' && c.contains(node)); }
    focus() { doc.activeElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { if (!this.disabled) return this.onclick?.({ currentTarget: this }); }
    getContext() { return this.context; }
    getBoundingClientRect() { return { width: 200, height: 100 }; }
    querySelectorAll(selector: string): any[] {
      const match = (e: Element, s: string) => {
        if (s.includes(':not(:disabled)') && e.disabled) return false;
        s = s.replace(':not(:disabled)', '');
        const tag = /^[a-z]+/i.exec(s)?.[0];
        if (tag && e.tagName !== tag.toUpperCase()) return false;
        for (const m of s.matchAll(/\.([\w-]+)/g)) if (!e.className.split(' ').includes(m[1])) return false;
        for (const m of s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
          const v = m[1].startsWith('data-') ? e.dataset[m[1].slice(5)] : e.getAttribute(m[1]);
          if (m[2] === undefined ? v === undefined || v === null : v !== m[2]) return false;
        }
        return true;
      };
      const descendants = (e: Element): Element[] => e.children.filter((c) => typeof c !== 'string').flatMap((c) => [c, ...descendants(c)]);
      return descendants(this).filter((e) => selector.split(',').some((s) => {
        const parts = s.trim().split(/\s+/);
        if (!match(e, parts.pop()!)) return false;
        let p = e.parentElement;
        while (parts.length && p) { if (match(p, parts.at(-1)!)) parts.pop(); p = p.parentElement; }
        return !parts.length;
      }));
    }
    querySelector(s: string) { return this.querySelectorAll(s)[0] ?? null; }
    cloneNode() { return new Element(this.tagName); }
  }
  doc.createElement = (tag: string) => new Element(tag.toUpperCase());
  doc.createElementNS = (_ns: string, tag: string) => doc.createElement(tag);
  doc.createTextNode = (s: string) => s;
  doc.documentElement = new Element('HTML'); doc.body = new Element('BODY');
  vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('document', doc);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = vi.fn(); });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => key }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return { all, doc, element: doc.createElement };
}

export function fakeEncoder(options: { flush?: () => Promise<void>; order?: number[] } = {}) {
  const instances: any[] = [];
  class Encoder {
    static async isConfigSupported() { return { supported: true }; }
    state = 'configured'; encodeQueueSize = 0; timestamps: number[] = [];
    constructor(readonly handlers: any) { instances.push(this); }
    configure() {}
    emit(timestamp: number) {
      this.handlers.output({ byteLength: 1, copyTo: (b: Uint8Array) => b.set([1]), timestamp, type: 'key' },
        { decoderConfig: { description: Uint8Array.of(1, 100, 0, 40) } });
    }
    encode(frame: any) { this.timestamps.push(frame.timestamp); if (!options.order) this.emit(frame.timestamp); }
    async flush() { if (options.order) options.order.forEach((k) => this.emit(this.timestamps[k])); await options.flush?.(); }
    close() { this.state = 'closed'; }
  }
  vi.stubGlobal('VideoEncoder', Encoder);
  vi.stubGlobal('VideoFrame', class { timestamp: number; constructor(_: any, o: any) { this.timestamp = o.timestamp; } close() {} });
  return instances;
}
