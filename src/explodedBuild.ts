import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { BuildInfo } from './sourceOverlay';

type Logger = (message: string) => void;

export interface ExplodedBuildResult {
  ok: boolean;
  /** Absolute path to the resulting exploded webapp folder (has a WEB-INF subfolder). Only set when ok is true. */
  explodedPath?: string;
  message?: string;
}

/** Same PATH/encoding defensive setup as buildRunner.ts's runBuildOnce - see there for the
 *  full rationale (missing System32 on PATH breaking cmd.exe internals, non-UTF8 codepages). */
function buildEnv(javaHome: string | undefined, log: Logger): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const system32 = path.join(windir, 'System32');
    const currentPath = env.PATH ?? '';
    if (!currentPath.toLowerCase().includes(system32.toLowerCase())) {
      env.PATH = [currentPath, windir, system32].filter(Boolean).join(path.delimiter);
    }
  }
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH ?? ''}`;
    log(`[build] using JAVA_HOME = ${javaHome}`);
  }
  return env;
}

/** Prefers the project's own wrapper script (mvnw/gradlew) over a bare mvn/gradle on PATH,
 *  same convention as buildRunner.ts, when the corresponding setting is left at its default. */
function resolveCommand(buildInfo: BuildInfo, mavenCommand: string, gradleCommand: string): string {
  const isWin = process.platform === 'win32';
  if (buildInfo.tool === 'maven') {
    const wrapper = path.join(buildInfo.projectRoot, isWin ? 'mvnw.cmd' : 'mvnw');
    return mavenCommand === 'mvn' && fs.existsSync(wrapper) ? (isWin ? '.\\mvnw.cmd' : './mvnw') : mavenCommand;
  }
  const wrapper = path.join(buildInfo.projectRoot, isWin ? 'gradlew.bat' : 'gradlew');
  return gradleCommand === 'gradle' && fs.existsSync(wrapper) ? (isWin ? '.\\gradlew.bat' : './gradlew') : gradleCommand;
}

function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: Logger
): Promise<{ ok: boolean; message?: string }> {
  // `&` (not `&&`) so a chcp failure never silently prevents the actual command from running -
  // see buildRunner.ts's runBuildOnce for the full story on why this bit us before.
  const commandToRun = process.platform === 'win32' ? `chcp 65001>nul & ${command}` : command;
  log(`[build] running: ${command}`);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(commandToRun, { cwd, shell: true, env });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log(`[build] failed to start: ${message}`);
      resolve({ ok: false, message });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => log(d.toString().trimEnd()));
    child.stderr?.on('data', (d: Buffer) => log(d.toString().trimEnd()));
    child.on('exit', code => resolve({ ok: code === 0, message: code !== 0 ? `exit code ${code}` : undefined }));
    child.on('error', err => resolve({ ok: false, message: err.message }));
  });
}

/** Recursively-shallow scan: finds the most-recently-modified immediate subfolder of `root`
 *  that looks like an exploded webapp (has a WEB-INF subfolder), skipping known non-webapp
 *  Maven/Gradle output folders. Used both after running a fresh build (instead of predicting
 *  Maven's exact `finalName`, customizable in pom.xml, so not safe to assume) and to detect a
 *  build that already exists from a previous run (in or outside this extension). */
export function findNewestExplodedDir(root: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  const skip = new Set([
    'classes',
    'test-classes',
    'generated-sources',
    'maven-status',
    'maven-archiver',
    'libs',
    'resources',
    'tmp',
    'reports',
    'test-results',
    'distributions'
  ]);
  let best: { path: string; mtimeMs: number } | undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    if (!fs.existsSync(path.join(candidate, 'WEB-INF'))) continue;
    const mtimeMs = fs.statSync(candidate).mtimeMs;
    if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
  }
  return best?.path;
}

/** Where a build for `buildInfo` would already have left an exploded webapp, if one has run
 *  before (via this extension, another IDE, or the command line) - checked before offering to
 *  kick off a fresh build, so an already-built app doesn't get mistaken for an unbuilt one just
 *  because the user pointed this command at the project root instead of the build output
 *  folder directly. Maven's `target/` is scanned directly since `war:exploded`/`package`
 *  always land there; Gradle's plain `war` task only ever produces a `.war` file (not an
 *  exploded folder) unless something has explicitly unpacked it before, so only this
 *  extension's own past `build/tomcat-exploded/` output is considered "already built" there. */
export function findExistingExplodedOutput(buildInfo: BuildInfo): string | undefined {
  if (buildInfo.tool === 'maven') {
    return findNewestExplodedDir(path.join(buildInfo.projectRoot, 'target'));
  }
  return findNewestExplodedDir(path.join(buildInfo.projectRoot, 'build', 'tomcat-exploded'));
}

function findNewestFile(dir: string, ext: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  let best: { path: string; mtimeMs: number } | undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(ext)) continue;
    const candidate = path.join(dir, entry.name);
    const mtimeMs = fs.statSync(candidate).mtimeMs;
    if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
  }
  return best?.path;
}

/**
 * Runs the project's build tool to produce (or refresh) an exploded webapp directory, and
 * returns its path - used when the user picks a Maven/Gradle project that hasn't been built
 * (deployed) as an exploded webapp yet, so "Deploy Exploded Folder..." can build it instead of
 * just failing.
 *
 * - Maven: `war:exploded` (a maven-war-plugin goal) writes straight to `target/<finalName>`.
 *   `compile` runs first so it has fresh classes to work with (and, via Maven's default
 *   lifecycle ordering, resource processing too). Afterward this scans `target/` for the
 *   result rather than predicting `finalName`, since that's customizable in pom.xml.
 * - Gradle: there's no war-plugin task that reliably survives across Gradle versions and
 *   produces an exploded directory directly, so this builds the ordinary `.war` (`gradle war`)
 *   and unpacks it - via the JDK's own `jar` tool, so no extra dependency is needed - into a
 *   `build/tomcat-exploded/<warBaseName>` folder that this extension owns outright and can
 *   freely wipe/recreate on every build.
 */
export async function buildExplodedWebapp(
  buildInfo: BuildInfo,
  options: { mavenCommand?: string; gradleCommand?: string; javaHome?: string; log?: Logger }
): Promise<ExplodedBuildResult> {
  const log = options.log ?? (() => {});
  const env = buildEnv(options.javaHome, log);
  const cmd = resolveCommand(buildInfo, options.mavenCommand ?? 'mvn', options.gradleCommand ?? 'gradle');

  if (buildInfo.tool === 'maven') {
    const result = await runShell(`${cmd} compile war:exploded -q`, buildInfo.projectRoot, env, log);
    if (!result.ok) {
      log(`[build] exploded build failed${result.message ? `: ${result.message}` : ''}`);
      return { ok: false, message: result.message ?? 'Maven 빌드에 실패했습니다.' };
    }
    const explodedPath = findNewestExplodedDir(path.join(buildInfo.projectRoot, 'target'));
    if (!explodedPath) {
      const msg = 'target/ 아래에서 WEB-INF 를 포함한 폴더를 찾지 못했습니다 (pom.xml의 packaging이 war 인지 확인해주세요).';
      log(`[build] ${msg}`);
      return { ok: false, message: msg };
    }
    log(`[build] exploded webapp ready: ${explodedPath}`);
    return { ok: true, explodedPath };
  }

  // Gradle
  const buildResult = await runShell(`${cmd} war -q`, buildInfo.projectRoot, env, log);
  if (!buildResult.ok) {
    log(`[build] exploded build failed${buildResult.message ? `: ${buildResult.message}` : ''}`);
    return { ok: false, message: buildResult.message ?? 'Gradle 빌드에 실패했습니다.' };
  }
  const warFile = findNewestFile(path.join(buildInfo.projectRoot, 'build', 'libs'), '.war');
  if (!warFile) {
    const msg = 'build/libs 아래에서 생성된 .war 파일을 찾지 못했습니다 (war 플러그인이 적용되어 있는지 확인해주세요).';
    log(`[build] ${msg}`);
    return { ok: false, message: msg };
  }

  const explodedPath = path.join(buildInfo.projectRoot, 'build', 'tomcat-exploded', path.basename(warFile, '.war'));
  try {
    fs.rmSync(explodedPath, { recursive: true, force: true });
    fs.mkdirSync(explodedPath, { recursive: true });
  } catch (err: any) {
    return { ok: false, message: `압축 해제용 폴더 준비 실패: ${err?.message ?? err}` };
  }

  const jarBin = options.javaHome
    ? path.join(options.javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar')
    : 'jar';
  const extractResult = await runShell(`"${jarBin}" xf "${warFile}"`, explodedPath, env, log);
  if (!extractResult.ok) {
    const msg =
      `.war 압축 해제 실패${extractResult.message ? `: ${extractResult.message}` : ''} ` +
      `(JDK의 jar 도구를 찾지 못했다면, 배포 대상 서버에서 "Set Java Home..." 으로 JDK 경로를 지정한 뒤 다시 시도해보세요).`;
    log(`[build] ${msg}`);
    return { ok: false, message: msg };
  }

  log(`[build] exploded webapp ready: ${explodedPath}`);
  return { ok: true, explodedPath };
}
