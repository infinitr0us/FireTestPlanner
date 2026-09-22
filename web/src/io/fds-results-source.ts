import { MAX_READ, safeResultPath, type ResultSource } from '../core/fds-results';
import { closeShellResults, readShellResult, type OpenedResults } from './files';

export function browserResultsSource(files: File[], smvPath: string): ResultSource {
  const prefix = smvPath.includes('/') ? smvPath.slice(0, smvPath.lastIndexOf('/') + 1) : '';
  const selected = new Map<string, File>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!path.startsWith(prefix)) continue;
    const name = safeResultPath(path.slice(prefix.length));
    if (selected.has(name)) throw new Error(`Duplicate result path: ${name}`);
    selected.set(name, file);
  }
  return {
    files: new Map([...selected].map(([name, file]) => [name, file.size])),
    async read(name, offset, length) {
      const file = selected.get(name);
      if (!file) throw new Error(`Missing file: ${name}`);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > MAX_READ || offset + length > file.size) throw new Error(`Invalid byte range: ${name}`);
      const data = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      if (data.length !== length) throw new Error(`Truncated read: ${name}`);
      return data;
    },
    close: () => selected.clear(),
  };
}
export function desktopResultsSource(opened: OpenedResults): ResultSource {
  return { files: new Map(opened.files.map(f => [f.name, f.size])),
    read: (name, offset, length) => readShellResult(opened.token, name, offset, length),
    close: () => closeShellResults(opened.token) };
}
