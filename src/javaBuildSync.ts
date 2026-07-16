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
 *
 * Also exposes buildOnce(), used to run a fresh compile before Tomcat even starts (so it
 * boots against up-to-date classes rather than whatever happened to be built last).
 */
export class JavaBuildSyncWatcher {
  private handles: RecursiveWatchHandle[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private building: Promise<boolean> | undefined;
  private pendingRebuild = false;
  private disposed = false;

  constructor(
    private buildInfo: BuildInfo,
    private classesTargetDir: string,
    private log: Logger = () => {},
    private javaHome?: string
  ) {}

  /** Sets up watching for ongoing changes. Does NOT itself run a build - call buildOnce()
   *  first if you want a guaranteed-fresh build (e.g. right before starting Tomcat); this
   *  only syncs whatever output already happens to exist so WEB-INF/classes starts populated. */
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

    this.syncOutputDirs();
  }

  stop(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const h of this.handles) h.close();
    this.handles = [];
  }

  /** Runs the compile command once and waits for it to finish, syncing the output on
   *  success. Returns true on success. Coalesces with any build already in flight rather
   *  than starting a redundant second one. */
  async buildOnce(): Promise<boolean> {
    if (this.building) {
      return this.building;
    }
    this.building = this.executeBuild();
    const result = await this.building;
    this.building = undefined;
    if (this.pendingRebuild && !this.disposed) {
      this.pendingRebuild = false;
      // Fire and forget - a change arrived while we were building, so build again.
      void this.buildOnce();
    }
    return result;
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
    this.debounceTimer = setTimeout(() => void this.buildOnce(), DEBOUNCE_MS);
  }

  private executeBuild(): Promise<boolean> {
    this.log(`[build] running: ${this.buildInfo.buildCommand}`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Make Maven's JVM diagnostics UTF-8; otherwise Korean Windows console output is
    // decoded as UTF-8 by Node and becomes unreadable in the VS Code output channel.
    const utf8Options = '-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8';
    env.JAVA_TOOL_OPTIONS = [env.JAVA_TOOL_OPTIONS, utf8Options].filter(Boolean).join(' ');
    if (this.javaHome) {
      env.JAVA_HOME = this.javaHome;
      const javaBin = path.join(this.javaHome, 'bin');
      env.PATH = `${javaBin}${path.delimiter}${env.PATH ?? ''}`;
      this.log(`[build] using JAVA_HOME = ${this.javaHome} (same as this Tomcat server's Set Java Home)`);
    }

    return new Promise(resolve => {
      const child = spawn(this.buildInfo.buildCommand, {
        cwd: this.buildInfo.projectRoot,
        shell: true,
        env
      });

      let combinedOutput = '';
      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        combinedOutput += text;
        this.log(text.trimEnd());
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        combinedOutput += text;
        this.log(text.trimEnd());
      });

      const finish = (success: boolean, detail?: string) => {
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
          this.logKnownFailureHint(combinedOutput);
        }
        resolve(success);
      };

      child.on('exit', code => finish(code === 0, code !== 0 ? `exit code ${code}` : undefined));
      child.on('error', err => finish(false, err.message));
    });
  }

  /** Recognizes a few very common failure signatures and logs a one-line pointer to the
   *  likely fix, since these otherwise-cryptic Maven/Gradle errors come up a lot when the
   *  JDK used to run the build doesn't match what the project expects. */
  private logKnownFailureHint(output: string): void {
    if (/package javax\.xml\.bind does not exist|package javax\.annotation does not exist/.test(output)) {
      this.log(
        '[build] 힌트: JDK 11+ 에서는 javax.xml.bind(JAXB)/javax.annotation 이 JDK에서 제거되었습니다. ' +
          '이 프로젝트가 JDK 8 대상이라면, 서버 우클릭 → "Set Java Home..." 으로 JDK 8 경로를 지정하면 ' +
          '이 빌드도 같은 JDK로 실행됩니다. (또는 pom.xml에 javax.xml.bind:jaxb-api 의존성을 추가하는 방법도 있습니다.)'
      );
      return;
    }
    if (/invalid target release|invalid source release/.test(output)) {
      this.log(
        '[build] 힌트: 프로젝트가 요구하는 Java 소스/타깃 버전과 실제 사용 중인 JDK 버전이 맞지 않는 것 같습니다. ' +
          '서버 우클릭 → "Set Java Home..." 으로 프로젝트에 맞는 JDK를 지정해보세요.'
      );
      return;
    }
    if (/'mvn' is not recognized|mvn: command not found|'gradle' is not recognized|gradle: command not found/.test(output)) {
      this.log(
        '[build] 힌트: mvn/gradle 명령을 찾을 수 없습니다. 시스템 PATH에 Maven/Gradle 을 추가하거나, ' +
          'tomcat.mavenCommand / tomcat.gradleCommand 설정에 전체 경로를 지정해보세요.'
      );
    }
  }
}
