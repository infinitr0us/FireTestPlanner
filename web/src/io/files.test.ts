/**
 * File in, file out -- the parts that can be tested without a browser.
 *
 * The load-bearing one is the shared viewer's embedding: the plan goes inside a
 * `<script>` element, and a plan is someone else's file. Anything in it that the
 * HTML parser reads as the end of that element runs as code on whoever opens the
 * export.
 */

import { describe, expect, it } from 'vitest';

import { embedPlanInHtml, escapeJsonForScript } from './files';

const BOOT = '<!doctype html>\n<html><head><title>Fire Test Plan Editor</title>'
  + '<script type="application/json" id="embedded-plan"></script></head>'
  + '<body><script>app()</script></body></html>';

/** What the browser hands `embeddedPlanText()`: the raw content of the tag. */
const embedded = (html: string): string =>
  /<script type="application\/json" id="embedded-plan">([\s\S]*?)<\/script>/.exec(html)![1].trim();

describe('embedding a plan in the shared viewer', () => {
  it('shares only testData basenames and leaves the working sources intact', () => {
    const source = JSON.stringify({ objects: [], testData: [{ id: 'run', file: { path: 'E:/private/run.xlsx' } }] });
    const html = embedPlanInHtml(BOOT, source, 'Test data');
    expect(JSON.parse(embedded(html)).testData[0].file.path).toBe('run.xlsx');
    expect(html).not.toContain('private');
    expect(JSON.parse(source).testData[0].file.path).toBe('E:/private/run.xlsx');
  });
  it('shares only linked basenames while preserving labels, snapshots and the source document', () => {
    const paths = ['E:/Users/name/data.csv', '//private-server/share/video.mp4', '../private/run.tsv', 'D:\\secret\\book.xlsx'];
    const links = paths.map((path, i) => ({ id: String(i), kind: 'spreadsheet', path, label: 'Run ' + i,
      plot: { importedAt: 'date', samples: [[-1, 1.234567891, 2]] } }));
    const source = JSON.stringify({ objects: [{ type: 'burner', linkedFiles: links }] });
    const html = embedPlanInHtml(BOOT, source, 'T');
    const shared = JSON.parse(embedded(html)).objects[0].linkedFiles;
    expect(shared).toEqual(links.map((link, i) => ({ ...link, path: ['data.csv', 'video.mp4', 'run.tsv', 'book.xlsx'][i] })));
    expect(html).not.toMatch(/private-server|private\/|secret|Users/);
    expect(JSON.parse(source).objects[0].linkedFiles).toEqual(links);
  });
  it('keeps every closing-tag spelling the HTML parser accepts out of the script', () => {
    // The exact string `</script>` used to be the only thing escaped. The parser
    // also ends the element at `</script >`, `</SCRIPT\t>` and `</script/>`, and
    // treats `<!--` specially -- so a note containing any of those broke out of the
    // JSON and, with a second `<script>`, ran on the reader's machine.
    const notes = 'x</script ><script>marker()</script >y</SCRIPT\t>z</script/>w<!--';
    const plan = { format: 'fire-test-plan', meta: { notes } };
    const html = embedPlanInHtml(BOOT, JSON.stringify(plan), 'T');

    const body = embedded(html);
    expect(body).not.toMatch(/<\/script/i);
    expect(body).not.toContain('<!--');
    expect(body).not.toContain('<');
    // The rest of the page still has exactly the tags it started with.
    expect(html.match(/<\/script/gi)).toHaveLength(2);
  });

  it('round-trips the plan unchanged through JSON.parse', () => {
    const plan = {
      format: 'fire-test-plan',
      meta: { notes: 'a </script > b <!-- c --> d < e   f', title: '<b>&amp;</b>' },
      objects: [{ id: '<x>', type: 'burner' }],
    };
    const html = embedPlanInHtml(BOOT, JSON.stringify(plan), 'T');
    expect(JSON.parse(embedded(html))).toEqual(plan);
  });

  it('escapes only inside strings, because that is the only place < can be', () => {
    expect(escapeJsonForScript('{"a":"<"}')).toBe('{"a":"\\u003c"}');
    expect(escapeJsonForScript('{"a":1}')).toBe('{"a":1}');
  });

  it('sets the page title without letting it inject markup', () => {
    const html = embedPlanInHtml(BOOT, '{}', 'Bay 3 <script>x</script>');
    expect(html).toContain('<title>Bay 3 &lt;script&gt;x&lt;/script&gt;</title>');
    expect(html.match(/<\/script/gi)).toHaveLength(2);
  });

  it('takes a title literally, dollar patterns included', () => {
    // As a replacement string, `$'` spliced the rest of the page into <title>.
    for (const title of ["Budget $' test", 'Cost $$5', 'A $& B', 'C $` D']) {
      const html = embedPlanInHtml(BOOT, '{}', title);
      expect(html).toContain(`<title>${title.replace(/&/g, '&amp;')}</title>`);
      expect(html.match(/<script/gi)).toHaveLength(2);
      expect(html.length).toBeLessThan(BOOT.length + title.length + 20);
    }
  });

  it('strips directories from the links of object types this build does not know', () => {
    const source = JSON.stringify({ objects: [{ id: 'f', type: 'futureThing',
      linkedFiles: [{ id: 'a', kind: 'spreadsheet', path: 'C:/Users/alice/other/run.csv' }] }] });
    const html = embedPlanInHtml(BOOT, source, 'T');
    expect(JSON.parse(embedded(html)).objects[0].linkedFiles[0].path).toBe('run.csv');
    expect(html).not.toContain('alice');
  });
});
