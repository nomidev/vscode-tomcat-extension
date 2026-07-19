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
  /** Where compiled classes + processed resources land once *something* builds this project
   *  (VSCode's own Java language server as you save .java files, a manual `mvn compile` /
   *  `gradle classes` in a terminal, IntelliJ, CI, etc.) - this extension never runs a build
   *  itself, it only watches these folders and mirrors them into WEB-INF/classes live. Maven
   *  puts everything in one folder; Gradle splits classes and resources into two. */
  classesOutDirs: string[];
}

/**
 * Detects whether `projectRoot` is a Maven or Gradle project and, if so, returns where its
 * compiled output lands (used to live-sync into WEB-INF/classes - see JavaBuildSyncWatcher).
 */
export function detectBuildInfo(projectRoot: string): BuildInfo | undefined {
  if (fs.existsSync(path.join(projectRoot, 'pom.xml'))) {
    return {
      tool: 'maven',
      projectRoot,
      // Maven's `process-resources` + `compile` phases both write into target/classes, so
      // compiled .class files and copied resources end up together in one place.
      classesOutDirs: [path.join(projectRoot, 'target', 'classes')]
    };
  }

  if (
    fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
    fs.existsSync(path.join(projectRoot, 'build.gradle.kts'))
  ) {
    return {
      tool: 'gradle',
      projectRoot,
      // Gradle keeps compiled classes and processed resources in separate output folders.
      classesOutDirs: [
        path.join(projectRoot, 'build', 'classes', 'java', 'main'),
        path.join(projectRoot, 'build', 'resources', 'main')
      ]
    };
  }

  return undefined;
}
