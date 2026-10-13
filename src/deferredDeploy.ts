import * as fs from 'fs';
import * as path from 'path';

/**
 * Support for the `tomcat.deployAppsAfterStartup` option ("start Tomcat first, deploy the apps
 * afterwards").
 *
 * How it works: Tomcat deploys whatever it finds in conf/Catalina/<host>/ (context descriptors)
 * and webapps/ (WARs / exploded dirs) as part of its own boot, so the "Server startup in N ms"
 * line only shows up once every app has finished initializing. To defer that, the files that
 * make an app deployable are moved into a parking folder right before Tomcat is spawned, and
 * moved back once Tomcat reports it's up - Tomcat's Host autoDeploy background scan (on by
 * default) then notices them like any hot deploy and deploys each app while the server is
 * already running. No Manager credentials or restart are involved.
 *
 * Everything here is plain fs work with no vscode dependency, so it can be unit tested.
 */

/** The minimum an app needs for the parking logic (a subset of DeployedApp). */
export interface ParkableApp {
  contextPath: string;
  sourcePath: string;
  type: 'war' | 'exploded';
}

export interface DeployFile {
  /** Where Tomcat looks for it. */
  original: string;
  /** Where it waits while the server boots. */
  parked: string;
}

/** Folder (inside CATALINA_HOME, so renames stay on the same volume) where files wait. */
export function parkingDir(homePath: string): string {
  return path.join(homePath, 'conf', 'vscode-tomcat-deferred');
}

function descriptorBaseName(app: ParkableApp): string {
  if (app.type === 'war') {
    return path.basename(app.sourcePath, '.war');
  }
  const appName = app.contextPath === '/' ? 'ROOT' : app.contextPath.replace(/^\/+/, '');
  return appName === '' ? 'ROOT' : appName;
}

/**
 * Every file/folder that makes this app deployable, paired with its parking spot. Order matters
 * when moving things back: a WAR (and its unpacked folder) goes before its context descriptor,
 * so Tomcat's scan can never see a descriptor whose docBase isn't there yet.
 *
 * - WAR apps: webapps/<name>.war, the unpacked webapps/<name>/ folder (otherwise Tomcat would
 *   still deploy that folder at boot), and conf/Catalina/localhost/<name>.xml (Tomcat copies a
 *   WAR's own META-INF/context.xml there; left behind it would be deployed at boot as well).
 * - Exploded apps: just the context descriptor conf/Catalina/localhost/<name>.xml (docBase
 *   points at the project folder, which is never touched).
 */
export function appDeployFiles(homePath: string, app: ParkableApp): DeployFile[] {
  const parked = parkingDir(homePath);
  const name = descriptorBaseName(app);
  const files: DeployFile[] = [];
  if (app.type === 'war') {
    files.push({
      original: path.join(homePath, 'webapps', `${name}.war`),
      parked: path.join(parked, 'webapps', `${name}.war`)
    });
    files.push({
      original: path.join(homePath, 'webapps', name),
      parked: path.join(parked, 'webapps', name)
    });
  }
  files.push({
    original: path.join(homePath, 'conf', 'Catalina', 'localhost', `${name}.xml`),
    parked: path.join(parked, 'localhost', `${name}.xml`)
  });
  return files;
}

function rmQuiet(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Moves the deployment files of each given app into the parking folder. Returns the contextPaths
 * of the apps that really were parked (an app with nothing on disk, or one whose files couldn't
 * be moved - e.g. locked on Windows - is left alone and simply deploys at boot as usual).
 */
export function parkApps(homePath: string, apps: ParkableApp[], log: (msg: string) => void): string[] {
  const parkedPaths: string[] = [];
  for (const app of apps) {
    const moved: DeployFile[] = [];
    try {
      for (const f of appDeployFiles(homePath, app)) {
        if (!fs.existsSync(f.original)) continue;
        rmQuiet(f.parked);
        fs.mkdirSync(path.dirname(f.parked), { recursive: true });
        fs.renameSync(f.original, f.parked);
        moved.push(f);
      }
    } catch (err: any) {
      // Put back whatever this app already moved, so it deploys at boot like normal.
      for (const f of moved.reverse()) {
        try {
          fs.renameSync(f.parked, f.original);
        } catch {
          // nothing more we can do
        }
      }
      log(`[Tomcat] ${app.contextPath} 앱 파일을 대기 폴더로 옮기지 못해 서버 시작 때 함께 배포합니다: ${err?.message ?? err}`);
      continue;
    }
    if (moved.length > 0) parkedPaths.push(app.contextPath);
  }
  return parkedPaths;
}

/**
 * Moves everything in the parking folder back to where Tomcat looks for it. Scan-based on
 * purpose, so it also recovers from a session that died while apps were parked (VSCode closed
 * or crashed mid-boot) - call it at the start of every server start and whenever the process
 * ends. If the destination already exists (the app was re-deployed meanwhile) the newer file
 * wins and the parked copy is dropped. Returns the names that were moved back.
 */
export function restoreParked(homePath: string, log?: (msg: string) => void): string[] {
  const root = parkingDir(homePath);
  if (!fs.existsSync(root)) return [];

  const restored: string[] = [];
  // webapps first, then descriptors (see appDeployFiles)
  const groups = [
    { sub: 'webapps', dest: path.join(homePath, 'webapps') },
    { sub: 'localhost', dest: path.join(homePath, 'conf', 'Catalina', 'localhost') }
  ];
  for (const g of groups) {
    const dir = path.join(root, g.sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const from = path.join(dir, name);
      const to = path.join(g.dest, name);
      try {
        if (fs.existsSync(to)) {
          rmQuiet(from); // a newer copy was put there while this one was parked
        } else {
          fs.mkdirSync(g.dest, { recursive: true });
          fs.renameSync(from, to);
          restored.push(name);
        }
      } catch (err: any) {
        log?.(`[Tomcat] 대기 중이던 ${name} 을(를) 원래 위치로 되돌리지 못했습니다: ${err?.message ?? err}`);
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty - leave it
    }
  }
  try {
    fs.rmdirSync(root);
  } catch {
    // not empty - leave it
  }
  return restored;
}

/** Drops the parked copies of one app (used when it's undeployed while its files are parked). */
export function discardParked(homePath: string, app: ParkableApp): void {
  for (const f of appDeployFiles(homePath, app)) {
    rmQuiet(f.parked);
  }
}

/**
 * True when the localhost <Host> has autoDeploy="false". Deploying after startup relies on
 * Tomcat's autoDeploy scan noticing the files, so this option can't work then.
 */
export function isHostAutoDeployDisabled(homePath: string): boolean {
  try {
    const xml = fs.readFileSync(path.join(homePath, 'conf', 'server.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const host = xml.match(/<Host\b[^>]*\bname="localhost"[^>]*>/);
    return !!host && /\bautoDeploy\s*=\s*"false"/i.test(host[0]);
  } catch {
    return false;
  }
}
