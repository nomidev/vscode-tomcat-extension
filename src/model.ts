export type ServerStatus = 'stopped' | 'starting' | 'running' | 'debugging' | 'stopping';

export interface DeployedApp {
  /** e.g. "/myapp" or "" for ROOT */
  contextPath: string;
  /** absolute path to the .war file or the exploded webapp folder */
  sourcePath: string;
  type: 'war' | 'exploded';
  /** For exploded (typically Maven) deployments: an additional source folder (e.g. src/main/webapp)
   *  layered on top of docBase via Tomcat <Resources><PreResources>, so JSP/static file edits are
   *  picked up instantly without rebuilding or restarting. */
  sourceOverlayPath?: string;
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
