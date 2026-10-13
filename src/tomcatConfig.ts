import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/**
 * Helpers that read/patch Tomcat's conf/server.xml and talk to its shutdown port. Plain fs/net
 * work with no vscode dependency, so they can be unit tested against temp files (and a real
 * Tomcat).
 */

/** Same length as the input (comment text becomes spaces, newlines kept) so offsets found in the
 *  masked copy are valid in the original text - commented-out example tags never match. */
function maskComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\r\n]/g, ' '));
}

function attrValue(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
}

export interface HttpConnectorRef {
  port: number;
  /** Offsets of the port digits in the original text, so the value can be patched in place. */
  valueStart: number;
  valueEnd: number;
}

/**
 * Finds the plain-HTTP <Connector> (HTTP/1.1, not TLS) and where its numeric port sits in the
 * file. Attribute order doesn't matter, AJP/HTTPS connectors and commented-out examples are
 * skipped, and a connector whose port isn't a literal number (e.g. "${http.port}") is ignored.
 */
export function findHttpConnector(xml: string): HttpConnectorRef | undefined {
  const masked = maskComments(xml);
  const re = /<Connector\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const tag = m[0];
    const protocol = attrValue(tag, 'protocol');
    const isHttp11 =
      protocol === undefined ||
      /^HTTP\/1\.1$/i.test(protocol) ||
      /^org\.apache\.coyote\.http11\.Http11(Nio|Nio2|Apr)?Protocol$/.test(protocol);
    if (!isHttp11) continue;
    if (/\bSSLEnabled\s*=\s*"true"/i.test(tag)) continue;
    const portMatch = /\bport\s*=\s*"(\d+)"/.exec(tag);
    if (!portMatch) continue;
    const valueStart = m.index + portMatch.index + portMatch[0].indexOf('"') + 1;
    return { port: parseInt(portMatch[1], 10), valueStart, valueEnd: valueStart + portMatch[1].length };
  }
  return undefined;
}

export function readHttpPort(homePath: string): number | undefined {
  try {
    const xml = fs.readFileSync(path.join(homePath, 'conf', 'server.xml'), 'utf8');
    return findHttpConnector(xml)?.port;
  } catch {
    return undefined;
  }
}

export interface ApplyPortResult {
  changed: boolean;
  /** The port server.xml had before (when a connector was found). */
  from?: number;
  /** Why nothing could be done (only set when changed is false and from is undefined). */
  reason?: 'unreadable' | 'no-connector';
}

/** Makes server.xml's HTTP connector listen on `port`, touching nothing else in the file. */
export function applyHttpPort(homePath: string, port: number): ApplyPortResult {
  const file = path.join(homePath, 'conf', 'server.xml');
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return { changed: false, reason: 'unreadable' };
  }
  const connector = findHttpConnector(xml);
  if (!connector) return { changed: false, reason: 'no-connector' };
  if (connector.port === port) return { changed: false, from: connector.port };
  fs.writeFileSync(file, xml.slice(0, connector.valueStart) + String(port) + xml.slice(connector.valueEnd), 'utf8');
  return { changed: true, from: connector.port };
}

export interface ShutdownConfig {
  port: number;
  command: string;
  address?: string;
}

/** The <Server port="8005" shutdown="SHUTDOWN"> settings, or undefined when the shutdown port is
 *  disabled (port="-1") or can't be read. */
export function readShutdownConfig(homePath: string): ShutdownConfig | undefined {
  try {
    const xml = maskComments(fs.readFileSync(path.join(homePath, 'conf', 'server.xml'), 'utf8'));
    const tag = /<Server\b[^>]*>/.exec(xml)?.[0];
    if (!tag) return undefined;
    const port = parseInt(attrValue(tag, 'port') ?? '', 10);
    const command = attrValue(tag, 'shutdown');
    if (!(port > 0) || !command) return undefined;
    return { port, command, address: attrValue(tag, 'address') };
  } catch {
    return undefined;
  }
}

function sendOnce(host: string, port: number, command: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean, socket?: net.Socket) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(ok);
    };
    const socket = net.createConnection({ host, port }, () => {
      // Tomcat reads until the connection closes and compares what it got to the shutdown word.
      socket.write(command, () => socket.end());
    });
    socket.setTimeout(timeoutMs, () => done(false, socket));
    socket.on('error', () => done(false, socket));
    socket.on('close', () => done(true, socket));
  });
}

/**
 * Asks Tomcat to shut itself down cleanly by sending the shutdown word to its shutdown port - the
 * same thing `catalina stop` does. Unlike killing the process this lets the webapps run their
 * contextDestroyed / Spring close / connection pool cleanup. Resolves true once the command was
 * delivered (not once Tomcat has finished stopping), false if the port couldn't be reached.
 */
export async function sendShutdown(cfg: ShutdownConfig, timeoutMs: number = 2000): Promise<boolean> {
  const hosts =
    cfg.address && cfg.address.toLowerCase() !== 'localhost' ? [cfg.address] : ['127.0.0.1', '::1'];
  for (const host of hosts) {
    if (await sendOnce(host, cfg.port, cfg.command, timeoutMs)) return true;
  }
  return false;
}
