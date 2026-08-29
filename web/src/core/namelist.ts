/**
 * Fortran namelist reader, as FDS writes them. Mirror of python/fireplan/namelist.py.
 *
 * FDS input is a sequence of namelist records: `&GROUP key=value, ... /`. Anything
 * outside a record is a comment, which is how FDS files carry prose -- and it is
 * also how a line gets disabled, by deleting its leading `&`. That last point is not
 * a curiosity: the sample file in `fixtures/fds/` has a `REAC` line carrying
 * `RADIATIVE_FRACTION=0.29` that FDS never reads, and a reader that picks it up is
 * quietly wrong about the fire.
 *
 * Three rules here are the ones a quick regex gets wrong, and all three are
 * exercised by that same sample file:
 *
 * - **A record ends at the first `/` that is not inside a string.** The sample's
 *   `&HEAD` title contains `34.2x1000/300=114s`, so a reader that stops at the first
 *   `/` truncates the very first record in the file.
 * - **Parameters separate on commas *or* whitespace.** The sample's `&SURF`,
 *   `&MATL` and `&PROP` records use newlines and no commas at all, so a
 *   comma-splitter silently loses `HRRPUA` and a thermocouple's `DIAMETER`.
 * - **Subscripted assignments accumulate.** `MATL_ID(1,1)='X'` followed by
 *   `MATL_ID(2,1)='Y'` is two writes into one array, not two values of which the
 *   last wins.
 *
 * This module is deliberately ignorant of what any of it means: it turns text into
 * records, and `fds.ts` decides what a record is for.
 */

export type NamelistValue = string | number | boolean | null;

export class NamelistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamelistError';
  }
}

/**
 * One `&GROUP ... /` record.
 *
 * `params` is keyed by the parameter name upper-cased and *without* its subscript,
 * so `SURF_ID6` and `SURF_ID` stay distinct while `THICKNESS(1:2)` and `THICKNESS`
 * are the same parameter.
 */
export class NamelistRecord {
  constructor(
    readonly group: string,
    readonly params: Map<string, NamelistValue[]>,
    readonly line: number,
  ) {}

  has(key: string): boolean {
    return this.params.has(key.toUpperCase());
  }

  values(key: string): NamelistValue[] {
    return this.params.get(key.toUpperCase()) ?? [];
  }

  value(key: string): NamelistValue | undefined {
    return this.values(key)[0];
  }

  number(key: string): number | null {
    const v = this.value(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  numbers(key: string): number[] {
    return this.values(key).filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
  }

  string(key: string): string | null {
    const v = this.value(key);
    return typeof v === 'string' ? v : null;
  }

  /** String values, keeping null holes so positional lists stay aligned --
   *  `SURF_ID6` is read by face index, so a gap has to stay a gap. */
  strings(key: string): Array<string | null> {
    return this.values(key).map((v) => (typeof v === 'string' ? v : null));
  }

  boolean(key: string): boolean | null {
    const v = this.value(key);
    return typeof v === 'boolean' ? v : null;
  }
}

// -- 1. carving the text into records -------------------------------------

const GROUP_NAME = /^&([A-Za-z]\w*)/;

interface Span {
  group: string;
  body: string;
  offset: number;
}

/**
 * Every record's group, body and offset, in file order.
 *
 * Character-by-character rather than a regex because the terminating `/` has to be
 * recognised outside strings only, and no regex can say that without modelling the
 * string grammar anyway.
 */
function recordSpans(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const start = text.indexOf('&', i);
    if (start < 0) break;
    const match = GROUP_NAME.exec(text.slice(start));
    if (!match) {
      i = start + 1;
      continue;
    }

    const group = match[1].toUpperCase();
    const bodyStart = start + match[0].length;
    let j = bodyStart;
    let quote: string | null = null;

    while (j < n) {
      const ch = text[j];
      if (quote !== null) {
        if (ch === quote) {
          // '' inside a single-quoted string is an escaped quote, not the end.
          if (ch === "'" && text[j + 1] === "'") j += 1;
          else quote = null;
        }
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === '/') {
        break;
      }
      j += 1;
    }

    out.push({ group, body: text.slice(bodyStart, j), offset: start });
    if (group === 'TAIL') break; // FDS stops reading here; so does this.
    i = j + 1;
  }
  return out;
}

// -- 2. splitting a record body into parameters ---------------------------

/** `body` with string *contents* replaced by X, so the assignment scan below cannot
 *  mistake an `=` inside a title for a parameter. */
function maskStrings(body: string): string {
  let out = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote !== null) {
      out += ch === quote ? ch : 'X';
      if (ch === quote) quote = null;
    } else {
      out += ch;
      if (ch === "'" || ch === '"') quote = ch;
    }
  }
  return out;
}

const ASSIGNMENT = /([A-Za-z_]\w*)\s*(\([^)]*\))?\s*=/g;

/** One value: a quoted string, or a run of anything that is not a separator.
 *  Commas and whitespace are both separators -- see the module comment. */
const VALUE = /'(?:[^']|'')*'|"[^"]*"|[^,\s]+/g;

const REPEAT = /^(\d+)\*(.*)$/;
const LOGICAL = /^\.(TRUE|FALSE|T|F)\.$/i;
/** Fortran spells a double-precision exponent with D. `1.2D3` is `1.2e3`; the
 *  anchoring keeps it away from an unquoted word that merely contains a D. */
const FORTRAN_REAL = /^[-+]?(\d+\.?\d*|\.\d+)[dD][-+]?\d+$/;

function scalar(token: string): NamelistValue {
  const first = token[0];
  if (first === "'" || first === '"') {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  if (LOGICAL.test(token)) return token[1].toUpperCase() === 'T';
  if (FORTRAN_REAL.test(token)) return Number(token.replace(/[dD]/, 'e'));
  // Number() is deliberately not used alone: it maps '' and whitespace to 0 and
  // accepts '0x10', none of which is a Fortran real.
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(token)) return Number(token);
  return token; // an unquoted word; FDS accepts these for some parameters
}

function parseValues(raw: string): NamelistValue[] {
  const out: NamelistValue[] = [];
  for (const token of raw.match(VALUE) ?? []) {
    const repeat = REPEAT.exec(token);
    const count = repeat ? Number(repeat[1]) : 1;
    const body = repeat ? repeat[2] : token;
    if (!body) continue;
    const v = scalar(body);
    for (let k = 0; k < count; k += 1) out.push(v);
  }
  return out;
}

/**
 * The 1-based start index of a subscript like `(2)`, `(1:2,1)` or `(3,1)`.
 *
 * Only the first dimension is honoured. FDS's genuinely two-dimensional parameters
 * (`MATL_ID(layer, component)`) are material data this format has no use for, and
 * flattening them onto the first index keeps the layer order rather than refusing
 * the record.
 */
function firstIndex(subscript: string | undefined): number | null {
  if (!subscript) return null;
  const head = subscript.replace(/[()]/g, '').split(',')[0].trim();
  const first = head.split(':')[0].trim();
  const n = Number.parseInt(first, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Write `values` into `params[key]`, honouring a subscript as a 1-based offset.
 *
 * Without the offset, `THICKNESS(1)=0.1` followed by `THICKNESS(2)=0.2` would leave
 * 0.2 alone in the list and lose the first layer.
 */
function assign(
  params: Map<string, NamelistValue[]>,
  key: string,
  subscript: string | undefined,
  values: NamelistValue[],
): void {
  const index = firstIndex(subscript);
  if (index === null) {
    // An unsubscripted write replaces the whole value, as Fortran does.
    params.set(key, [...values]);
    return;
  }
  const slot = params.get(key) ?? [];
  const start = Math.max(index - 1, 0);
  while (slot.length < start) slot.push(null);
  slot.splice(start, values.length, ...values);
  params.set(key, slot);
}

function parseParams(body: string): Map<string, NamelistValue[]> {
  const masked = maskStrings(body);
  const hits: Array<{ key: string; subscript?: string; start: number; end: number }> = [];
  ASSIGNMENT.lastIndex = 0;
  let m: RegExpExecArray | null = ASSIGNMENT.exec(masked);
  while (m !== null) {
    hits.push({ key: m[1].toUpperCase(), subscript: m[2], start: m.index, end: m.index + m[0].length });
    m = ASSIGNMENT.exec(masked);
  }

  const params = new Map<string, NamelistValue[]>();
  hits.forEach((hit, k) => {
    const end = k + 1 < hits.length ? hits[k + 1].start : body.length;
    const raw = body.slice(hit.end, end).trim().replace(/,$/, '');
    assign(params, hit.key, hit.subscript, parseValues(raw));
  });
  return params;
}

// -- 3. the public entry points -------------------------------------------

/** Every namelist record in `text`, in file order. */
export function readNamelist(text: string): NamelistRecord[] {
  return recordSpans(text).map(({ group, body, offset }) => {
    const line = text.slice(0, offset).split('\n').length;
    return new NamelistRecord(group, parseParams(body), line);
  });
}

/**
 * Exactly one record, for a line pasted into the editor.
 *
 * Throws rather than guessing, because "nothing happened" is the worst possible
 * answer to a paste. A missing leading `&` is the mistake people actually make --
 * it is how an FDS line gets commented out -- so it gets its own message.
 */
export function readOneRecord(text: string): NamelistRecord {
  const stripped = text.trim();
  if (!stripped) throw new NamelistError('Nothing to read.');

  const records = readNamelist(stripped);
  if (records.length === 0) {
    ASSIGNMENT.lastIndex = 0;
    if (ASSIGNMENT.test(maskStrings(stripped))) {
      throw new NamelistError(
        'No "&" to start the record — FDS reads only lines that begin with &GROUP, '
        + `so this one is a comment. Try:\n\n&OBST ${stripped} /`,
      );
    }
    throw new NamelistError(
      'No namelist record found. Expected something like:\n\n&OBST XB=0,1,0,1,0,2 /',
    );
  }
  if (records.length > 1) {
    throw new NamelistError(
      `${records.length} records here, and this takes one at a time: `
      + records.slice(0, 4).map((r) => `&${r.group}`).join(', '),
    );
  }
  if (records[0].params.size === 0) {
    throw new NamelistError(`&${records[0].group} has no parameters.`);
  }
  return records[0];
}
