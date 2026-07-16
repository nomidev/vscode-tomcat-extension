import * as fs from 'fs';
import * as path from 'path';

export interface RecursiveWatchHandle {
  close(): void;
}

/**
 * Watches a directory tree for changes, calling onChange(relativePath) for every event.
 * Uses fs.watch's native `recursive` option on Windows/macOS, and falls back to a manual
 * per-directory watch (with dynamic re-watching of newly created subdirectories) on Linux,
 * where inotify doesn't support recursive watches directly.
 */
export function watchRecursive(
  rootDir: string,
  onChange: (relPath: string) => void,
  log: (msg: string) => void = () => {}
): RecursiveWatchHandle {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const w = fs.watch(rootDir, { recursive: true }, (_event, filename) => {
        if (filename) onChange(filename.toString());
      });
      return { close: () => w.close() };
    } catch (err) {
      log(`[watch] recursive watch failed, falling back to manual mode: ${err}`);
    }
  }

  const watchers = new Map<string, fs.FSWatcher>();

  const watchDir = (dir: string) => {
    if (watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, (_event, filename) => {
        if (!filename) return;
        const abs = path.join(dir, filename.toString());
        const rel = path.relative(rootDir, abs);
        onChange(rel);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          watchDir(abs);
        }
      });
      watchers.set(dir, w);
    } catch (err) {
      log(`[watch] failed to watch ${dir}: ${err}`);
      return;
    }
    for (const entry of safeReadDir(dir)) {
      if (entry.isDirectory()) watchDir(path.join(dir, entry.name));
    }
  };
  watchDir(rootDir);

  return {
    close: () => {
      for (const w of watchers.values()) w.close();
      watchers.clear();
    }
  };
}

export function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursively copies every file/folder from src into dest, creating folders as needed. */
export function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of safeReadDir(src)) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
