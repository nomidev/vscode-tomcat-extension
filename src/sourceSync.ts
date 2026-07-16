import * as fs from 'fs';
import * as path from 'path';
import { watchRecursive, copyDirRecursive, RecursiveWatchHandle } from './recursiveWatch';

type Logger = (message: string) => void;

/**
 * Mirrors a source folder (e.g. src/main/webapp) into a deployed docBase folder by copying
 * files over on change. This sidesteps Tomcat's <Resources><PreResources> overlay mechanism
 * entirely (which has known stability issues on some Tomcat 8.0.x builds - see
 * DirResourceSet NullPointerException reports) in favor of something that works identically
 * on any Tomcat version, since Tomcat just sees ordinary file changes inside docBase and
 * picks them up the same way it would if you'd edited the deployed file directly (JSPs
 * recompile automatically in development mode; static files are served fresh immediately).
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
    copyDirRecursive(this.sourceDir, this.targetDir);

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
