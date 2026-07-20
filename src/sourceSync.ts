import * as fs from 'fs';
import * as path from 'path';
import { watchRecursive, copyDirRecursive, RecursiveWatchHandle } from './recursiveWatch';

type Logger = (message: string) => void;

/**
 * Mirrors a source folder (e.g. src/main/webapp) into a deployed docBase folder by copying
 * files over on change.
 *
 * IMPORTANT - why this copies instead of symlinking/junctioning: an earlier version of this
 * class used Windows directory junctions (and symlinks elsewhere) to make docBase point
 * *directly* at the source folder with zero copying. That turned out to be dangerous: tools
 * that recursively delete a directory tree don't reliably treat a junction as a link to skip
 * over - notably, Maven's `clean` plugin on Windows (via plexus-utils'
 * FileUtils.deleteDirectory) can recurse *through* a junction and delete whatever it points
 * to, rather than just removing the junction itself. Since those junctions lived inside
 * target/<artifactId> - exactly what `mvn clean` wipes - running `mvn clean` while live
 * reload was on could silently delete real files under src/main/webapp. That's unacceptable:
 * a dev-convenience feature must never risk deleting the user's actual source code. Copying
 * has no such failure mode - there is no link for `mvn clean` (or anything else) to wander
 * through, so it only ever touches build output, never the source tree, regardless of what
 * deletes target/ or how.
 *
 * Only files that exist in the source folder are touched - WEB-INF/classes, WEB-INF/lib and
 * anything else that only exists in the build output are left completely alone.
 */
export class SourceSyncWatcher {
  private handle: RecursiveWatchHandle | undefined;

  constructor(private sourceDir: string, private targetDir: string, private log: Logger = () => {}) {}

  start(): void {
    if (!fs.existsSync(this.sourceDir)) {
      this.log(`[sync] source folder not found, skipping: ${this.sourceDir}`);
      return;
    }

    this.log(`[sync] initial copy: ${this.sourceDir} -> ${this.targetDir}`);
    try {
      copyDirRecursive(this.sourceDir, this.targetDir);
    } catch (err) {
      this.log(`[sync] initial copy error: ${err}`);
    }

    this.handle = watchRecursive(this.sourceDir, relPath => this.handleChange(relPath), this.log);
    this.log(`[sync] watching: ${this.sourceDir}`);
  }

  stop(): void {
    this.handle?.close();
    this.handle = undefined;
  }

  private handleChange(relPath: string): void {
    if (!relPath) return;
    const src = path.join(this.sourceDir, relPath);
    const dest = path.join(this.targetDir, relPath);

    try {
      if (fs.existsSync(src)) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          this.log(`[sync] copied ${relPath}`);
        }
      } else if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
        this.log(`[sync] removed ${relPath}`);
      }
    } catch (err) {
      this.log(`[sync] error syncing ${relPath}: ${err}`);
    }
  }
}
