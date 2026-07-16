import * as fs from 'fs';
import * as path from 'path';

export interface ParsedContext {
  /** context path declared in the file, e.g. "/myapp" or "" for ROOT (undefined if not declared) */
  path?: string;
  /** attributes on the <Context> tag, excluding path/docBase (those are computed by the deploy step) */
  attributes: Record<string, string>;
  /** raw inner XML (child elements such as <Resource>, <Environment>, <Parameter>, ...), trimmed */
  innerXml: string;
}

/**
 * Looks for META-INF/context.xml inside a webapp folder (or an already-exploded WAR).
 * Returns undefined if the folder doesn't have one.
 */
export function findMetaInfContext(webappFolder: string): string | undefined {
  const candidate = path.join(webappFolder, 'META-INF', 'context.xml');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Parses a Tomcat context.xml file (root <Context> element) using light regex-based
 * extraction (no extra XML-parser dependency needed for this well-known, simple format).
 */
export function parseMetaInfContext(xmlPath: string): ParsedContext | undefined {
  let xml: string;
  try {
    xml = fs.readFileSync(xmlPath, 'utf8');
  } catch {
    return undefined;
  }

  const tagMatch = xml.match(/<Context([^>]*?)(\/>|>([\s\S]*?)<\/Context>)/i);
  if (!tagMatch) return undefined;

  const attrsStr = tagMatch[1] ?? '';
  const inner = tagMatch[3] ?? '';

  const attributes: Record<string, string> = {};
  const attrRegex = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrsStr)) !== null) {
    attributes[m[1]] = m[2];
  }

  const path_ = attributes['path'];
  delete attributes['path'];
  delete attributes['docBase'];

  return {
    path: path_,
    attributes,
    innerXml: inner.trim()
  };
}
