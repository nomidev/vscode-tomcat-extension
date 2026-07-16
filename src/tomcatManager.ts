import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TomcatServerConfig } from './model';

const MANAGER_USERNAME = 'vscode-tomcat';

function secretKey(serverId: string): string {
  return `tomcat.managerPassword.${serverId}`;
}

/** Strips XML comments before running detection regexes against a tomcat-users.xml file.
 *  Tomcat's shipped default file contains several commented-out example <role>/<user>
 *  blocks (including a "manager-script" example) - without this, a plain regex test would
 *  be fooled into thinking the role/user is already actively configured when it's actually
 *  just example text inside a comment, silently skipping the real (active) insertion. */
function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

export interface ManagerCredentials {
  username: string;
  password: string;
  /** True if a brand-new manager-script user was just added to tomcat-users.xml. The default
   *  realm only reads that file at startup, so a restart is required once before Manager
   *  calls will authenticate successfully. */
  justProvisioned: boolean;
}

/** Whether this Tomcat installation includes the bundled Manager web application. */
export function hasManagerApp(homePath: string): boolean {
  return fs.existsSync(path.join(homePath, 'webapps', 'manager'));
}

function buildUserEntry(password: string): { rolenameTag: string; userTag: string } {
  return {
    rolenameTag: `  <role rolename="manager-script"/>`,
    userTag: `  <user username="${MANAGER_USERNAME}" password="${password}" roles="manager-script"/>`
  };
}

/** Removes any existing (active, non-commented) <role rolename="manager-script"/> and
 *  <user username="vscode-tomcat" .../> entries from the raw file content, leaving
 *  everything else (including comments) untouched. Used both to avoid duplicates when
 *  re-provisioning and by the explicit reset command. */
function removeActiveEntries(content: string): string {
  // Only ever emitted by this extension with this exact shape, so a straightforward
  // string-based match is safe (and avoids accidentally touching commented-out examples,
  // since we generate these without any indentation matching the shipped examples).
  content = content.replace(/[ \t]*<role rolename="manager-script"\/>\n?/g, '');
  content = content.replace(new RegExp(`[ \\t]*<user[^>]*username="${MANAGER_USERNAME}"[^>]*/>\\n?`, 'g'), '');
  return content;
}

function readOrInitUsersXml(usersXmlPath: string): string {
  let content = fs.existsSync(usersXmlPath)
    ? fs.readFileSync(usersXmlPath, 'utf8')
    : '<?xml version="1.0" encoding="UTF-8"?>\n<tomcat-users>\n</tomcat-users>\n';
  if (!content.includes('</tomcat-users>')) {
    content += '\n<tomcat-users>\n</tomcat-users>\n';
  }
  return content;
}

function provisionUser(server: TomcatServerConfig, usersXmlPath: string): string {
  const password = crypto
    .randomBytes(24)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 24);

  let content = readOrInitUsersXml(usersXmlPath);
  content = removeActiveEntries(content);

  const { rolenameTag, userTag } = buildUserEntry(password);
  const strippedForDetection = stripXmlComments(content);
  const needsRoleTag = !/<role\s+rolename="manager-script"\s*\/>/.test(strippedForDetection);

  const insertion = (needsRoleTag ? `${rolenameTag}\n` : '') + `${userTag}\n`;
  content = content.replace('</tomcat-users>', `${insertion}</tomcat-users>`);

  fs.mkdirSync(path.dirname(usersXmlPath), { recursive: true });
  fs.writeFileSync(usersXmlPath, content, 'utf8');
  return password;
}

/**
 * Ensures conf/tomcat-users.xml has a user with the manager-script role that this extension
 * can use to call the Manager text API (deploy/undeploy/reload a single context instantly,
 * without restarting the whole server - the same trick IntelliJ's Tomcat integration relies
 * on). Creates one with a random password if none exists yet. The password is kept in
 * VSCode's SecretStorage, never written to settings.json.
 */
export async function ensureManagerUser(
  server: TomcatServerConfig,
  secrets: vscode.SecretStorage
): Promise<ManagerCredentials> {
  const usersXmlPath = path.join(server.homePath, 'conf', 'tomcat-users.xml');
  const existingPassword = await secrets.get(secretKey(server.id));

  if (existingPassword && fs.existsSync(usersXmlPath)) {
    const active = stripXmlComments(fs.readFileSync(usersXmlPath, 'utf8'));
    if (active.includes(`username="${MANAGER_USERNAME}"`) && active.includes('rolename="manager-script"')) {
      return { username: MANAGER_USERNAME, password: existingPassword, justProvisioned: false };
    }
  }

  const password = provisionUser(server, usersXmlPath);
  await secrets.store(secretKey(server.id), password);
  return { username: MANAGER_USERNAME, password, justProvisioned: true };
}

/**
 * Forcibly regenerates the Manager credentials from scratch - removes any existing
 * vscode-tomcat role/user entries (active ones; comments are left alone) and the stored
 * secret, then provisions a brand new user/password. Use this to self-recover from a 401
 * (e.g. the file was hand-edited, corrupted, or got out of sync with the stored secret).
 * Like first-time provisioning, this requires a server restart to take effect.
 */
export async function resetManagerUser(
  server: TomcatServerConfig,
  secrets: vscode.SecretStorage
): Promise<ManagerCredentials> {
  const usersXmlPath = path.join(server.homePath, 'conf', 'tomcat-users.xml');
  const password = provisionUser(server, usersXmlPath);
  await secrets.store(secretKey(server.id), password);
  return { username: MANAGER_USERNAME, password, justProvisioned: true };
}

export interface ManagerResult {
  ok: boolean;
  message: string;
  /** HTTP status code, when a response was received at all (e.g. 401/403/404). */
  statusCode?: number;
}

