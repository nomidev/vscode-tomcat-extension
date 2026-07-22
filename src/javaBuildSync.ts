import * as fs from 'fs';
import * as path from 'path';
import { watchRecursive, copyDirRecursive, RecursiveWatchHandle } from './recursiveWatch';
import { BuildInfo } from './sourceOverlay';

type Logger = (message: string) => void;

/**
 * Mirrors a Maven/Gradle project's already-compiled output (target/classes for Maven;
 * build/classes/java/main + build/resources/main for Gradle) into the deployed app's
 * WEB-INF/classes, live.
 *
 * This extension never invokes `mvn`/`gradle` itself - that avoids an entire class of
 * problems (PATH resolution, console encoding, JDK version mismatches, slow full-project
 * compiles). Instead it just watches whatever gets written to that output folder by whatever
 * actually builds it - VSCode's own Java language server incrementally compiling as you save
 * .java files (and copying resource files alongside, the same way Eclipse/JDT always has), a
 * manual `mvn compile` in a terminal, an IDE's own build, CI, anything - and copies any changed file
 * straight into WEB-INF/classes.
 *
 * Combined with Tomcat's `reloadable="true"` (the default for exploded deployments from this
 * extension), Tomcat's own background thread then reloads the context automatically once it
 * notices the class/resource change - no restart, no button. An attached Java debugger
 * (JPDA) may also hot-swap method-body-only changes directly into the running JVM even
 * faster, without needing a reload at all. Structural changes a debugger can't hot-swap
 * (new fields, new methods, new classes) still need that context reload (automatic) or, for
 * some frameworks that cache things more aggressively, a manual "Reload Context Now" /
 * restart - which is expected and fine.
 */
export class JavaBuildSyncWatcher {
  private handles: RecursiveWatchHandle[] = [];

  constructor(
    private buildInfo: BuildInfo,
    private classesTargetDir: string,
    private log: Logger = () => {}
  ) {}

  start(): void {
    const dirs = this.buildInfo.classesOutDirs;
    const existing = dirs.filter(dir => fs.existsSync(dir));
    if (existing.length === 0) {
      this.log(
        `[classes-sync] ${dirs.join(', ')} 이(가) 아직 없습니다. 프로젝트를 한 번 빌드하면(예: 저장 시 VSCode Java ` +
          `자동 빌드, 또는 터미널에서 mvn/gradle 빌드) 그 이후부터 자동으로 WEB-INF/classes 에 반영됩니다.`
      );
    }

    for (const dir of dirs) {
      this.syncAll(dir);
      this.handles.push(watchRecursive(dir, relPath => this.handleChange(dir, relPath), this.log));
    }
    this.log(`[classes-sync] watching: ${dirs.join(', ')} -> ${this.classesTargetDir}`);
  }

  stop(): void {
    for (const h of this.handles) h.close();
    this.handles = [];
  }

  /** Re-syncs everything immediately (used right before Tomcat starts, and by the manual
   *  "Force Resync Classes Now" command). No build is run - this just copies whatever is
   *  already sitting in the output folder(s) right now. Returns false if any output folder
   *  failed to sync (see syncAll), so callers like "Force Resync Classes Now" can actually
   *  tell the difference between "nothing to sync yet" and "something went wrong". */
  async buildOnce(): Promise<boolean> {
    let allOk = true;
    for (const dir of this.buildInfo.classesOutDirs) {
      if (!this.syncAll(dir)) allOk = false;
    }
    return allOk;
  }

  private syncAll(outDir: string): boolean {
    if (!fs.existsSync(outDir)) return true; // nothing to sync yet isn't a failure
    try {
      copyDirRecursive(outDir, this.classesTargetDir);
      return true;
    } catch (err) {
      // A locked .class file (e.g. actively held open on Windows) or a permission hiccup
      // must not take down the whole sync - let alone Tomcat's entire startup sequence,
      // which awaits this. Log and move on; the next change event will retry.
      this.log(`[classes-sync] error syncing ${outDir} -> ${this.classesTargetDir}: ${err}`);
      return false;
    }
  }

  private handleChange(outDir: string, relPath: string): void {
    if (!relPath) return;
    const src = path.join(outDir, relPath);
    const dest = path.join(this.classesTargetDir, relPath);

    try {
      if (fs.existsSync(src)) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          this.log(`[classes-sync] copied ${relPath}`);
        }
      } else if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
        this.log(`[classes-sync] removed ${relPath}`);
      }
    } catch (err) {
      this.log(`[classes-sync] error syncing ${relPath}: ${err}`);
    }
  }
}
