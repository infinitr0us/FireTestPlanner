import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { absoluteLinkPath, mapLinkedPaths, relativeLinkPath } from './link-paths';

describe('portable linked paths', () => {
  const cases = JSON.parse(readFileSync(new URL('../../../fixtures/linked-files/path-cases.json', import.meta.url), 'utf8')) as
    { source: string; path: string; destination: string; absolute: string; saved: string }[];
  it.each(cases)('matches Python rebasing: $path from $source', (c) => {
    const absolute = absoluteLinkPath(c.path, c.source);
    expect(absolute).toBe(c.absolute);
    expect(relativeLinkPath(absolute, c.destination)).toBe(c.saved);
  });
  it.each(['fixtures/plan.ftp.json', 'plan.ftp.json'])('does not invent a root from %s', (source) => {
    expect(absoluteLinkPath('volumes.csv', source)).toBe('volumes.csv');
    expect(relativeLinkPath('/data/volumes.csv', source)).toBe('/data/volumes.csv');
    const disk = '{"objects":[{"type":"burner","linkedFiles":[{"path":"volumes.csv"}]}]}';
    expect(mapLinkedPaths(disk, source, 'open')).toBe(disk);
  });
  it('rebases Save As without changing which local file is referenced', () => {
    const original = 'E:/test/day 1/plan.ftp.json';
    const target = absoluteLinkPath('data/volumes.csv', original);
    expect(target).toBe('E:/test/day 1/data/volumes.csv');
    expect(relativeLinkPath(target, 'E:/test/revisions/revised.ftp.json')).toBe('../day 1/data/volumes.csv');
    expect(absoluteLinkPath('../day 1/data/volumes.csv', 'E:/test/revisions/revised.ftp.json')).toBe(target);
  });
  it('handles drive case, different drives, UNC, Unicode and POSIX', () => {
    expect(relativeLinkPath('e:\\Test\\測定.csv', 'E:/test/p.json')).toBe('測定.csv');
    expect(relativeLinkPath('D:/video.mp4', 'E:/test/p.json')).toBe('D:/video.mp4');
    expect(absoluteLinkPath('../video.mp4', '//server/share/test/p.json')).toBe('//server/share/video.mp4');
    expect(relativeLinkPath('//server/other/video.mp4', '//server/share/p.json')).toBe('//server/other/video.mp4');
    expect(absoluteLinkPath('data/volumes.csv', '/test/p.json')).toBe('/test/data/volumes.csv');
    expect(relativeLinkPath('/test/data/volumes.csv', '/test/p.json')).toBe('data/volumes.csv');
  });
  it('moves a complete test folder and preserves the working copy through Save As', () => {
    const disk = JSON.stringify({ objects: [{ type: 'burner', linkedFiles: [{ path: 'data/volumes.csv' }] }] });
    const working = mapLinkedPaths(disk, 'E:/moved/p.json', 'open');
    const saved = mapLinkedPaths(working, 'E:/revisions/p.json', 'save');
    expect(JSON.parse(saved).objects[0].linkedFiles[0].path).toBe('../moved/data/volumes.csv');
    expect(JSON.parse(working).objects[0].linkedFiles[0].path).toBe('E:/moved/data/volumes.csv');
  });
  it('does not touch old plans, unknown objects or invalid JSON', () => {
    for (const text of ['{ broken', '{"objects":[]}', '{"objects":[{"type":"future","linkedFiles":[{"path":"data.csv"}]}]}']) {
      expect(mapLinkedPaths(text, 'E:/p.json', 'open')).toBe(text);
    }
    expect(absoluteLinkPath('https://host/test.csv', 'E:/p.json')).toBe('https://host/test.csv');
  });
});
