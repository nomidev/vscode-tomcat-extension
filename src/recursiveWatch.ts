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

  // If `dir` (or anything under it) no longer exists, its watcher is dead weight - inotify
  // silently drops it but the FSWatcher object and Map entry stay behind for the lifetime of
  // the whole watch session otherwise. On large multi-module projects, target/classes-style
  // trees with hundreds of package subdirectories being rebuilt (deleted + recreated) can
  // otherwise leave a similar number of stale watcher handles accumulating in memory over a
  // single long-running server session.
  const unwatchDir = (dir: string) => {
    const w = watchers.get(dir);
    if (!w) return;
    w.close();
    watchers.delete(dir);
    const prefix = dir + path.sep;
    for (const key of watchers.keys()) {
      if (key.startsWith(prefix)) {
        watchers.get(key)?.close();
        watchers.delete(key);
      }
    }
  };

  const watchDir = (dir: string) => {
    if (watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, (_event, filename) => {
        if (!fs.existsSync(dir)) {
          unwatchDir(dir);
          return;
        }
        if (!filename) return;
        const abs = path.join(dir, filename.toString());
        const rel = path.relative(rootDir, abs);
        onChange(rel);
        if (!fs.existsSync(abs)) return;
        if (fs.statSync(abs).isDirectory()) {
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

/** Recursively lists every file (not directory) under dir, as paths relative to dir. */
export function listAllFiles(dir: string, relPrefix = ''): string[] {
  const result: string[] = [];
  for (const entry of safeReadDir(dir)) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...listAllFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
  }
  return result;
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

/** Reads both files in fixed-size chunks and bails on the first difference, instead of pulling
 *  both of them fully into memory. syncAll() feeds every file under an output dir through here
 *  (server start, "Force Resync Classes Now", Toggle Auto Context Reload), so on a project with
 *  thousands of compiled classes the old readFileSync-both approach allocated two full copies
 *  of every file just to conclude "unchanged" for nearly all of them. */
function contentsEqual(src: string, dest: string): boolean {
  const CHUNK = 64 * 1024;
  let srcFd: number | undefined;
  let destFd: number | undefined;
  try {
    srcFd = fs.openSync(src, 'r');
    destFd = fs.openSync(dest, 'r');
    const srcBuf = Buffer.allocUnsafe(CHUNK);
    const destBuf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const srcRead = fs.readSync(srcFd, srcBuf, 0, CHUNK, null);
      const destRead = fs.readSync(destFd, destBuf, 0, CHUNK, null);
      if (srcRead !== destRead) return false; // shouldn't happen once sizes match, but be safe
      if (srcRead === 0) return true; // both hit EOF with everything so far equal
      if (!srcBuf.subarray(0, srcRead).equals(destBuf.subarray(0, destRead))) return false;
    }
  } catch {
    return false;
  } finally {
    if (srcFd !== undefined) try { fs.closeSync(srcFd); } catch { /* ignore */ }
    if (destFd !== undefined) try { fs.closeSync(destFd); } catch { /* ignore */ }
  }
}

/**
 * Whether src and dest are byte-for-byte identical (dest missing counts as "not identical").
 * Used by the incremental watchers (SourceSyncWatcher, JavaBuildSyncWatcher) to skip the
 * actual copy - and the log line/reload-trigger side effects that come with it - when a save
 * didn't really change the file's content. Habitually hitting Ctrl+S (or a build tool
 * touching a file's mtime without changing its bytes) shouldn't count as a real change: the
 * size check first makes the common "genuinely changed" case cheap, and the chunked byte
 * comparison only runs on the same-size case.
 *
 * Note mtime is deliberately NOT used as a shortcut: copyFileSync gives dest the copy's own
 * mtime, not src's, so dest's mtime is essentially always newer and an mtime check would
 * never hit.
 *
 * Pass srcSize when the caller has already stat'd src (the flushPending loops do) so this
 * doesn't stat the same file a second time.
 */
export function filesAreIdentical(src: string, dest: string, srcSize?: number): boolean {
  try {
    const srcBytes = srcSize ?? fs.statSync(src).size;
    if (srcBytes !== fs.statSync(dest).size) return false;
    if (srcBytes === 0) return true; // two empty files; skip opening them at all
    return contentsEqual(src, dest);
  } catch {
    return false;
  }
}
