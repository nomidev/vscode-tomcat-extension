import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { watchRecursive, copyDirRecursive, RecursiveWatchHandle } from './recursiveWatch';
import { BuildInfo } from './sourceOverlay';

type Logger = (message: string) => void;

const DEBOUNCE_MS = 800;

/**
 * Watches a Maven/Gradle project's `src/main/java` and `src/main/resources` folders. On any
 * change, debounces briefly then runs the project's compile command (e.g. `mvn compile -q`)
 * and, on success, mirrors the resulting classes/resources output folder into the deployed
 * app's `WEB-INF/classes`. Combined with Tomcat's `reloadable="true"` context setting (the
 * default for exploded deployments from this extension), Tomcat's own background class
 * change detection then reloads the context automatically - no manual restart needed.
 */
export class JavaBuildSyncWatcher {
  private handles: RecursiveWatchHandle[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private building = false;
  private pendingRebuild = false;
  private disposed = false;

  constructor(
    private buildInfo: BuildInfo,
    private classesTargetDir: string,
    private log: Logger = () => {}
  ) {}

  start(): void {
    const watchDirs = [this.buildInfo.javaSrcDir, this.buildInfo.resourcesSrcDir].filter(dir => fs.existsSync(dir));
    if (watchDirs.length === 0) {
      this.log('[build] no src/main/java or src/main/resources found, skipping auto-build watch');
      return;
    }

    for (const dir of watchDirs) {
      this.handles.push(watchRecursive(dir, () => this.scheduleBuild(), this.log));
    }
    this.log(`[build] watching for changes: ${watchDirs.join(', ')} (command: ${this.buildInfo.buildCommand})`);

    // Sync whatever's already been built so WEB-INF/classes starts up to date.
    this.syncOutputDirs();
  }

  stop(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const h of this.handles) h.close();
    this.handles = [];
  }

  private syncOutputDirs(): void {
    for (const outDir of this.buildInfo.classesOutDirs) {
      if (fs.existsSync(outDir)) {
        copyDirRecursive(outDir, this.classesTargetDir);
      }
    }
  }

  private scheduleBuild(): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.runBuild(), DEBOUNCE_MS);
  }

  private runBuild(): void {
    if (this.disposed) return;
    if (this.building) {
      this.pendingRebuild = true;
      return;
    }
    this.building = true;
    this.log(`[build] change detected, running: ${this.buildInfo.buildCommand}`);

    const child = spawn(this.buildInfo.buildCommand, {
      cwd: this.buildInfo.projectRoot,
      shell: true
    });

    let errorOutput = '';
    child.stdout?.on('data', (d: Buffer) => this.log(d.toString().trimEnd()));
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      errorOutput += text;
      this.log(text.trimEnd());
    });

    const finish = (success: boolean, detail?: string) => {
      this.building = false;
      if (success) {
        this.log('[build] compile succeeded, syncing classes...');
        try {
          this.syncOutputDirs();
          this.log(`[build] synced -> ${this.classesTargetDir}`);
        } catch (err) {
          this.log(`[build] error syncing classes: ${err}`);
        }
      } else {
        this.log(`[build] compile failed${detail ? `: ${detail}` : ''}`);
      }
      if (this.pendingRebuild && !this.disposed) {
        this.pendingRebuild = false;
        this.runBuild();
      }
    };

    child.on('exit', code => finish(code === 0, code !== 0 ? `exit code ${code}` : undefined));
    child.on('error', err => finish(false, err.message));
  }
}
