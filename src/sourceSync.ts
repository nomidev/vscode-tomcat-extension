import * as fs from 'fs';
import * as path from 'path';
import { copyDirRecursive, safeReadDir } from './recursiveWatch';

type Logger = (message: string) => void;

/** These must always keep coming from the Maven/Gradle build output, never from source. */
const PRESERVE_IN_WEBINF = new Set(['classes', 'lib']);

/**
 * Makes a deployed docBase directly reflect a source webapp folder (e.g. src/main/webapp) by
 * creating filesystem-level links - directory junctions/symlinks, or file symlinks/hard
 * links as a fallback - rather than copying file contents. This sidesteps Tomcat's
 * <Resources><PreResources> overlay mechanism entirely (which has known stability issues on
 * some Tomcat 8.0.x builds - see DirResourceSet NullPointerException reports), while still
 * behaving like a genuine "web resource directory" pointing straight at the source tree:
 * once a JSP or static file is linked, editing it is visible immediately with zero copy step
 * and zero watcher lag, because Tomcat is just following an ordinary filesystem link.
 *
 * WEB-INF/classes and WEB-INF/lib are always left completely alone - those come from the
 * Maven/Gradle build output (handled separately by JavaBuildSyncWatcher). Every other
 * top-level entry in the source folder, and every other entry under its WEB-INF, gets linked.
 *
 * Falls back automatically, entry by entry, to copying if a link can't be created (e.g. no
 * privilege for file symlinks on Windows without Developer Mode, or a cross-volume file that
 * can't be hard-linked) - so this still works everywhere, just without the zero-copy benefit
 * for whichever specific entries needed the fallback.
 */
export class SourceSyncWatcher {
  private topWatcher: fs.FSWatcher | undefined;
  private webInfWatcher: fs.FSWatcher | undefined;

  constructor(private sourceDir: string, private targetDir: string, private log: Logger = () => {}) {}

  start(): void {
    if (!fs.existsSync(this.sourceDir)) {
      this.log(`[link] source folder not found, skipping: ${this.sourceDir}`);
      return;
    }

    this.log(`[link] linking ${this.sourceDir} -> ${this.targetDir}`);
    this.syncTopLevel();

    try {
      this.topWatcher = fs.watch(this.sourceDir, () => this.syncTopLevel());
    } catch (err) {
      this.log(`[link] failed to watch ${this.sourceDir}: ${err}`);
    }

    const webInf = path.join(this.sourceDir, 'WEB-INF');
    if (fs.existsSync(webInf)) {
      try {
        this.webInfWatcher = fs.watch(webInf, () => this.syncTopLevel());
      } catch {
        // non-fatal - top-level entries already linked still work fine
      }
    }
  }

  stop(): void {
    this.topWatcher?.close();
    this.topWatcher = undefined;
    this.webInfWatcher?.close();
    this.webInfWatcher = undefined;
  }

  /**
   * Re-links every top-level entry (and every WEB-INF entry except classes/lib). Cheap
   * enough to re-run wholesale whenever something is added or removed at either of those two
   * levels - entries that are already correctly linked are detected and left untouched.
   */
  private syncTopLevel(): void {
    try {
      fs.mkdirSync(this.targetDir, { recursive: true });
      for (const entry of safeReadDir(this.sourceDir)) {
        if (entry.name === 'WEB-INF') continue;
        this.linkEntry(path.join(this.sourceDir, entry.name), path.join(this.targetDir, entry.name));
      }

      const srcWebInf = path.join(this.sourceDir, 'WEB-INF');
      if (fs.existsSync(srcWebInf)) {
        const destWebInf = path.join(this.targetDir, 'WEB-INF');
        fs.mkdirSync(destWebInf, { recursive: true });
        for (const entry of safeReadDir(srcWebInf)) {
          if (PRESERVE_IN_WEBINF.has(entry.name)) continue;
          this.linkEntry(path.join(srcWebInf, entry.name), path.join(destWebInf, entry.name));
        }
      }
    } catch (err) {
      this.log(`[link] error syncing: ${err}`);
    }
  }

  private removeIfExists(p: string): void {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p);
      }
    } catch {
      // didn't exist - nothing to remove
    }
  }

  private linkEntry(srcPath: string, destPath: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(srcPath);
    } catch {
      return;
    }

    // Already linked to the right place? Leave it alone.
    try {
      const existing = fs.lstatSync(destPath);
      if (existing.isSymbolicLink()) {
        const resolved = fs.readlinkSync(destPath);
        if (path.resolve(path.dirname(destPath), resolved) === path.resolve(srcPath)) {
          return;
        }
      }
    } catch {
      // doesn't exist yet - fall through to (re)link
    }

    this.removeIfExists(destPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (stat.isDirectory()) {
      try {
        fs.symlinkSync(srcPath, destPath, process.platform === 'win32' ? 'junction' : 'dir');
        this.log(`[link] ${destPath} -> ${srcPath}`);
        return;
      } catch (err) {
        this.log(`[link] directory link failed for ${path.basename(destPath)}, copying instead: ${err}`);
      }
      copyDirRecursive(srcPath, destPath);
      return;
    }

    try {
      fs.symlinkSync(srcPath, destPath, 'file');
      this.log(`[link] ${destPath} -> ${srcPath}`);
      return;
    } catch {
      // likely lacks privilege for file symlinks on Windows without Developer Mode - try a
      // hard link instead (no special privilege needed, but same-volume only)
    }
    try {
      fs.linkSync(srcPath, destPath);
      this.log(`[link] ${destPath} == ${srcPath} (hard link)`);
      return;
    } catch (err) {
      this.log(`[link] link failed for ${path.basename(destPath)}, copying instead: ${err}`);
    }
    try {
      fs.copyFileSync(srcPath, destPath);
    } catch (err) {
      this.log(`[link] copy fallback failed for ${path.basename(destPath)}: ${err}`);
    }
  }
}
