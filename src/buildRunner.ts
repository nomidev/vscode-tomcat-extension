import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { BuildInfo } from './sourceOverlay';

type Logger = (message: string) => void;

export interface BuildRunResult {
  ok: boolean;
  message?: string;
}

/** Resolves the actual command to run, preferring the project's own wrapper script
 *  (mvnw/gradlew) over a bare `mvn`/`gradle` on PATH when the corresponding setting is left
 *  at its default value. */
function resolveCommand(buildInfo: BuildInfo, mavenCommand: string, gradleCommand: string): string {
  const isWin = process.platform === 'win32';

  if (buildInfo.tool === 'maven') {
    const wrapper = path.join(buildInfo.projectRoot, isWin ? 'mvnw.cmd' : 'mvnw');
    const cmd = mavenCommand === 'mvn' && fs.existsSync(wrapper) ? (isWin ? '.\\mvnw.cmd' : './mvnw') : mavenCommand;
    return `${cmd} compile -q`;
  }

  const wrapper = path.join(buildInfo.projectRoot, isWin ? 'gradlew.bat' : 'gradlew');
  const cmd =
    gradleCommand === 'gradle' && fs.existsSync(wrapper) ? (isWin ? '.\\gradlew.bat' : './gradlew') : gradleCommand;
  return `${cmd} classes -q`;
}

/** Recognizes a few very common failure signatures and logs a one-line pointer to the likely
 *  fix, since these otherwise-cryptic Maven/Gradle errors come up a lot. */
function logKnownFailureHint(output: string, log: Logger): void {
  if (/package javax\.xml\.bind does not exist|package javax\.annotation does not exist/.test(output)) {
    log(
      '[build] 힌트: JDK 11+ 에서는 javax.xml.bind(JAXB)/javax.annotation 이 JDK에서 제거되었습니다. ' +
        '이 프로젝트가 JDK 8 대상이라면, 서버 우클릭 → "Set Java Home..." 으로 JDK 8 경로를 지정하면 ' +
        '이 빌드도 같은 JDK로 실행됩니다. (또는 pom.xml에 javax.xml.bind:jaxb-api 의존성을 추가하는 방법도 있습니다.)'
    );
    return;
  }
  if (/invalid target release|invalid source release/.test(output)) {
    log(
      '[build] 힌트: 프로젝트가 요구하는 Java 소스/타깃 버전과 실제 사용 중인 JDK 버전이 맞지 않는 것 같습니다. ' +
        '서버 우클릭 → "Set Java Home..." 으로 프로젝트에 맞는 JDK를 지정해보세요.'
    );
    return;
  }
  if (
    /'mvn' is not recognized|mvn: command not found|'gradle' is not recognized|gradle: command not found|내부 또는 외부 명령/.test(
      output
    )
  ) {
    log(
      '[build] 힌트: mvn/gradle 명령을 찾을 수 없습니다. 시스템 PATH에 Maven/Gradle 을 추가하거나, ' +
        'tomcat.mavenCommand / tomcat.gradleCommand 설정에 전체 경로를 지정해보세요.'
    );
  }
}

/**
 * Runs the project's compile command exactly once and waits for it to finish - used right
 * before Tomcat starts, so it boots against freshly-built classes rather than whatever
 * happened to be built last. Deliberately NOT wired up to run on every file save (that was
 * tried before and caused enough PATH/encoding/JDK-mismatch headaches that it was removed in
 * favor of just watching+mirroring whatever VSCode's own Java tooling already builds - see
 * javaBuildSync.ts). Here, as a single explicit action with its own clear log output, those
 * same rough edges are far less painful, so it's worth having as an opt-in convenience.
 *
 * Never throws - a build failure is logged and returned as `{ ok: false }` so callers (namely
 * ServerManager.start()) can log a warning and continue starting Tomcat anyway rather than
 * blocking indefinitely on a broken build.
 */
export function runBuildOnce(
  buildInfo: BuildInfo,
  options: { mavenCommand?: string; gradleCommand?: string; javaHome?: string; log?: Logger }
): Promise<BuildRunResult> {
  const log = options.log ?? (() => {});
  const command = resolveCommand(buildInfo, options.mavenCommand ?? 'mvn', options.gradleCommand ?? 'gradle');

  const env: NodeJS.ProcessEnv = { ...process.env };

  // Defensive: cmd.exe internals like `chcp` (actually chcp.com, an external file, not a
  // true built-in) and mvn.cmd/gradle.bat's own batch-script internals can depend on
  // C:\Windows\System32 being on PATH. If something upstream (a restrictive terminal profile,
  // a customized PATH, etc.) dropped it, restore it rather than silently failing.
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const system32 = path.join(windir, 'System32');
    const currentPath = env.PATH ?? '';
    if (!currentPath.toLowerCase().includes(system32.toLowerCase())) {
      env.PATH = [currentPath, windir, system32].filter(Boolean).join(path.delimiter);
    }
  }

  if (options.javaHome) {
    env.JAVA_HOME = options.javaHome;
    const javaBin = path.join(options.javaHome, 'bin');
    env.PATH = `${javaBin}${path.delimiter}${env.PATH ?? ''}`;
    log(`[build] using JAVA_HOME = ${options.javaHome} (same as this server's Set Java Home)`);
  }

  // On Windows, cmd.exe often uses a non-UTF8 codepage (e.g. CP949 on Korean systems), which
  // otherwise makes any non-ASCII output - including localized "command not found" messages -
  // show up as mojibake once decoded as UTF-8 on our end. Force UTF-8 first.
  // `&` (not `&&`) deliberately: chcp is only a best-effort encoding fix for readable log
  // output, never something the actual build should depend on. With `&&`, a chcp failure
  // (missing System32 in PATH, restricted environment, etc.) would silently prevent `command`
  // from ever running at all - exactly the "command not found" symptom this caused before,
  // even though mvn/gradle themselves were perfectly fine on PATH. `&` always runs the next
  // command regardless of whether chcp succeeded.
  const commandToRun = process.platform === 'win32' ? `chcp 65001>nul & ${command}` : command;
  log(`[build] running: ${command}`);

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(commandToRun, { cwd: buildInfo.projectRoot, shell: true, env });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log(`[build] failed to start: ${message}`);
      resolve({ ok: false, message });
      return;
    }

    let combinedOutput = '';
    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      combinedOutput += text;
      log(text.trimEnd());
    });
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      combinedOutput += text;
      log(text.trimEnd());
    });

    const finish = (ok: boolean, detail?: string) => {
      if (ok) {
        log('[build] compile succeeded');
      } else {
        log(`[build] compile failed${detail ? `: ${detail}` : ''}`);
        logKnownFailureHint(combinedOutput, log);
      }
      resolve({ ok, message: detail });
    };

    child.on('exit', code => finish(code === 0, code !== 0 ? `exit code ${code}` : undefined));
    child.on('error', err => finish(false, err.message));
  });
}
