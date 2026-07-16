import * as fs from 'fs';
import * as path from 'path';

/** Files that indicate a directory is a Maven or Gradle project root. */
const BUILD_MARKERS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

const DEFAULT_RELATIVE_SOURCE_DIR = 'src/main/webapp';

/**
 * Given a build-output folder (e.g. Maven's `target/<artifactId>`, or a Gradle exploded-war
 * output such as `build/exploded-<name>` / a custom Gretty/War-plugin output dir), walks up
 * the directory tree looking for the nearest ancestor that looks like a Maven or Gradle
 * project root, then checks whether that root - or a submodule guessed from the output
 * folder's own name (for simple multi-module layouts) - has the conventional webapp source
 * folder (`src/main/webapp` by default for both Maven's war plugin and Gradle's war plugin).
 *
 * @param relativeSourceDir Overridable via the `tomcat.webappSourceDir` setting, for projects
 *   that configure a non-default `webAppDirName` (Gradle) or otherwise don't use the standard
 *   Maven/Gradle convention.
 */
export function detectWebappSource(
  buildOutputPath: string,
  relativeSourceDir: string = DEFAULT_RELATIVE_SOURCE_DIR
): string | undefined {
  const segments = relativeSourceDir.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return undefined;

  let dir = buildOutputPath;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;

    const hasBuildFile = BUILD_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)));
    if (!hasBuildFile) continue;

    // Same-module convention: <projectRoot>/src/main/webapp
    const direct = path.join(dir, ...segments);
    if (fs.existsSync(direct)) return direct;

    // Simple multi-module convention: <projectRoot>/<moduleName>/src/main/webapp, guessing
    // the module name from the build output folder's own name
    // (e.g. target/myapp or build/exploded-myapp -> module "myapp").
    const moduleName = path
      .basename(buildOutputPath)
      .replace(/\.war$/i, '')
      .replace(/^exploded-/, '');
    const nested = path.join(dir, moduleName, ...segments);
    if (fs.existsSync(nested)) return nested;
  }
  return undefined;
}

/**
 * Walks up from a build-output folder to the nearest ancestor that looks like a Maven or
 * Gradle project root (i.e. contains one of BUILD_MARKERS). Used to locate `src/main/java`,
 * `src/main/resources`, and the build's compiled-classes output directory.
 */
export function findProjectRoot(startPath: string): string | undefined {
  let dir = startPath;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (BUILD_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)))) {
      return dir;
    }
  }
  return undefined;
}

export interface BuildInfo {
  tool: 'maven' | 'gradle';
  projectRoot: string;
  /** Shell command to run (cwd = projectRoot) that compiles Java sources and processes resources. */
  buildCommand: string;
  /** Where the build command's compiled classes + processed resources land. Maven puts both
   *  in one folder; Gradle splits them into separate folders, so this can be more than one. */
  classesOutDirs: string[];
  javaSrcDir: string;
  resourcesSrcDir: string;
}

/** Quote executable paths so configured commands under `Program Files` work in CMD. */
function shellCommand(executable: string, args: string[]): string {
  const quotedExecutable = /[\s"]/ .test(executable)
    ? `"${executable.replace(/"/g, '\\"')}"`
    : executable;
  return [quotedExecutable, ...args].join(' ');
}

/**
 * Detects whether `projectRoot` is a Maven or Gradle project and, if so, returns the info
 * needed to auto-compile Java changes and locate the resulting output. Prefers the project's
 * own wrapper script (mvnw/gradlew) when present, falling back to a bare `mvn`/`gradle` on
 * PATH. The exact commands can be overridden via the `tomcat.mavenCommand` /
 * `tomcat.gradleCommand` settings (passed in by the caller).
 */
export function detectBuildInfo(
  projectRoot: string,
  mavenCommand = 'mvn',
  gradleCommand = 'gradle'
): BuildInfo | undefined {
  const isWin = process.platform === 'win32';

  if (fs.existsSync(path.join(projectRoot, 'pom.xml'))) {
    const wrapper = path.join(projectRoot, isWin ? 'mvnw.cmd' : 'mvnw');
    const cmd = mavenCommand === 'mvn' && fs.existsSync(wrapper) ? (isWin ? '.\\mvnw.cmd' : './mvnw') : mavenCommand;
    return {
      tool: 'maven',
      projectRoot,
      buildCommand: shellCommand(cmd, ['compile']),
      // Maven's `compile` phase runs `process-resources` first, so target/classes ends up
      // with both compiled .class files and copied resources in one place.
      classesOutDirs: [path.join(projectRoot, 'target', 'classes')],
      javaSrcDir: path.join(projectRoot, 'src', 'main', 'java'),
      resourcesSrcDir: path.join(projectRoot, 'src', 'main', 'resources')
    };
  }

  if (
    fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
    fs.existsSync(path.join(projectRoot, 'build.gradle.kts'))
  ) {
    const wrapper = path.join(projectRoot, isWin ? 'gradlew.bat' : 'gradlew');
    const cmd =
      gradleCommand === 'gradle' && fs.existsSync(wrapper) ? (isWin ? '.\\gradlew.bat' : './gradlew') : gradleCommand;
    return {
      tool: 'gradle',
      projectRoot,
      // `classes` compiles Java AND processes resources for the main source set.
      buildCommand: shellCommand(cmd, ['classes']),
      // Gradle keeps compiled classes and processed resources in separate output folders.
      classesOutDirs: [
        path.join(projectRoot, 'build', 'classes', 'java', 'main'),
        path.join(projectRoot, 'build', 'resources', 'main')
      ],
      javaSrcDir: path.join(projectRoot, 'src', 'main', 'java'),
      resourcesSrcDir: path.join(projectRoot, 'src', 'main', 'resources')
    };
  }

  return undefined;
}
