import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ReleaseLintError } from '../types.js';
import { DEFAULT_MAX_ENTRY_BYTES, type ArchiveEntry, type ZipArchive } from './zip.js';

/** A React Native .app holds a few thousand files; this stops a wrong folder (a home directory) from being walked for minutes. */
const MAX_FILES = 100_000;

/** Folders release-lint can read directly: what Xcode leaves before an export. */
export const isAppFolderName = (name: string) => name.endsWith('.app') || name.endsWith('.xcarchive');

/**
 * Opens an iOS .app folder, or the app inside an .xcarchive, laid out the way an .ipa holds it
 * (`Payload/<Name>.app/…`), so the .ipa reader works unchanged.
 */
export async function openAppFolder(path: string): Promise<ZipArchive> {
  const appDir = path.endsWith('.xcarchive') ? await archivedApp(path) : path;
  const prefix = `Payload/${basename(appDir)}/`;
  const files = await listFiles(appDir);
  const entries = new Map<string, ArchiveEntry>([...files].map(([rel, { size }]) => [`${prefix}${rel}`, { name: `${prefix}${rel}`, size }]));
  return {
    entries,
    read: async (name, maxBytes = DEFAULT_MAX_ENTRY_BYTES) => {
      const file = name.startsWith(prefix) ? files.get(name.slice(prefix.length)) : undefined;
      if (!file) throw new ReleaseLintError(`No ${name} in the app`);
      const limit = Math.min(maxBytes, DEFAULT_MAX_ENTRY_BYTES);
      if (file.size > limit) throw new ReleaseLintError(`${name} is larger than ${limit} bytes`);
      const buf = await readFile(file.path);
      if (buf.length > limit) throw new ReleaseLintError(`${name} is larger than ${limit} bytes`); // it grew after listing
      return buf;
    },
    close: async () => {},
  };
}

async function archivedApp(archive: string): Promise<string> {
  const applications = join(archive, 'Products', 'Applications');
  const apps = await readdir(applications, { withFileTypes: true }).catch(() => []);
  const app = apps.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!app) throw new ReleaseLintError(`No app in ${basename(archive)}/Products/Applications`);
  return join(applications, app.name);
}

/**
 * Regular files by path relative to `root`, with `/` separators. Symlinks are skipped, never followed: they could point
 * outside the app.
 */
async function listFiles(root: string): Promise<Map<string, { path: string; size: number }>> {
  const files = new Map<string, { path: string; size: number }>();
  const pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push(rel);
      } else if (entry.isFile()) {
        if (files.size >= MAX_FILES) throw new ReleaseLintError(`The app folder has more than ${MAX_FILES} files`);
        const path = join(root, rel);
        files.set(rel, { path, size: (await lstat(path)).size });
      }
    }
  }
  return files;
}
