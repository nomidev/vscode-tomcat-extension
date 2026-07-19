export type ServerStatus = 'stopped' | 'starting' | 'running' | 'debugging' | 'stopping';

export interface DeployedApp {
  /** e.g. "/myapp" or "" for ROOT */
  contextPath: string;
  /** absolute path to the .war file or the exploded webapp folder */
  sourcePath: string;
  type: 'war' | 'exploded';
  /** For exploded (typically Maven/Gradle) deployments: an additional source folder (e.g.
   *  src/main/webapp) linked directly into docBase, so JSP/static file edits are picked up
   *  instantly without rebuilding or restarting. */
  sourceOverlayPath?: string;
  /** Extra <Context> attributes detected from the deployed app's own META-INF/context.xml
   *  (e.g. an explicit `path`, `override`, etc.), preserved so regenerating context.xml later
   *  (e.g. when toggling live reload) doesn't silently drop them. */
  contextExtraAttributes?: Record<string, string>;
  /** Raw child elements from the deployed app's own META-INF/context.xml - most importantly
   *  <Resource>/<Environment> JNDI definitions (e.g. a DataSource) - preserved the same way. */
  contextInnerXml?: string;
  /** Whether Tomcat should auto-reload this context's classloader when it notices a class/jar
   *  change under WEB-INF (Tomcat's own `reloadable` Context attribute). Defaults to true
   *  (Tomcat's own default) when unset. See serverManager.ts for the live-reload tradeoff:
   *  true reflects every class change automatically but tears down and rebuilds the whole
   *  context (Spring beans, sessions, etc.) every time; false relies on an attached Java
   *  debugger's hot-swap for simple changes and needs a manual "Reload Context Now" for
   *  anything hot-swap can't handle (new fields/methods/classes).
   */
  reloadable?: boolean;
}

export interface TomcatServerConfig {
  id: string;
  name: string;
  /** CATALINA_HOME */
  homePath: string;
  httpPort: number;
  debugPort: number;
  /** Optional JDK home used to run this server. If unset, the system default JAVA_HOME/PATH is used. */
  javaHome?: string;
  /** Optional per-server java.util.logging level override (SEVERE/WARNING/INFO/CONFIG/FINE/FINER/FINEST). Falls back to tomcat.defaultLogLevel setting when unset. */
  logLevel?: string;
  /** Optional extra JVM options (e.g. "-Xms256m -Xmx1024m -Dfoo=bar"), appended to CATALINA_OPTS on start. */
  vmOptions?: string;
  deployedApps: DeployedApp[];
}

export const LOG_LEVELS = ['SEVERE', 'WARNING', 'INFO', 'CONFIG', 'FINE', 'FINER', 'FINEST'] as const;

export const DEFAULT_HTTP_PORT = 8080;
export const DEFAULT_DEBUG_PORT = 8000;
