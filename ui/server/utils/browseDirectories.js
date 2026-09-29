import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Directory picking only needs immediate children, never a recursive file tree.
export async function browseDirectories(directory, showHidden = false) {
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = await Promise.all(entries.filter(entry => showHidden || !entry.name.startsWith('.')).map(async entry => {
    const target = path.join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = (await stat(target)).isDirectory(); } catch { return null; }
    }
    return isDirectory ? { name: entry.name, path: target, type: 'directory' } : null;
  }));
  return folders.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
