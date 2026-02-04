/**
 * Parse cURL commands into resource definitions
 */

import type { HttpMethod, QueryParam } from '../types';

export interface ParsedCurl {
  method: HttpMethod;
  url: string;
  path: string;
  headers: Record<string, string>;
  requestBody?: any;
  queryParams?: QueryParam[];
}

/**
 * Parse a cURL command string into a structured format
 */
export function parseCurl(curlCommand: string): ParsedCurl {
  // Remove leading/trailing whitespace but preserve content structure
  let command = curlCommand.trim();

  // Replace line continuations (backslash followed by newline) with space
  command = command.replace(/\\\r?\n/g, ' ');

  // Remove 'curl' at the start
  command = command.replace(/^curl\s+/i, '');

  // Extract method FIRST (before removing flags) with -X or --request
  let method: HttpMethod = 'GET';
  const methodMatch = command.match(/(?:-X|--request)\s+([A-Z]+)/i);
  if (methodMatch) {
    method = methodMatch[1].toUpperCase() as HttpMethod;
  }

  // Remove --location and --request flags (after extracting method)
  command = command.replace(/--location\s+/g, '');
  command = command.replace(/--request\s+[A-Z]+\s+/gi, '');
  command = command.replace(/-X\s+[A-Z]+\s+/gi, '');

  // Extract URL - it's the first quoted string after removing curl and flags
  const urlMatch = command.match(/['"]([^'"]+)['"]/);
  if (!urlMatch) {
    throw new Error('Could not find URL in cURL command');
  }
  const url = urlMatch[1];

  // Check for -d, --data, --data-raw (implies POST if method not specified)
  const hasData = /(?:-d|--data(?:-raw)?)\s+/.test(command);
  if (hasData && !methodMatch) {
    method = 'POST';
  }

  // Extract headers with -H or --header
  const headers: Record<string, string> = {};
  const headerRegex = /(?:-H|--header)\s+['"]([^'"]+)['"]/g;
  let headerMatch;
  while ((headerMatch = headerRegex.exec(command)) !== null) {
    const header = headerMatch[1];
    const colonIndex = header.indexOf(':');
    if (colonIndex > 0) {
      const key = header.substring(0, colonIndex).trim();
      const value = header.substring(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  // Extract body with -d, --data, or --data-raw
  // Match everything between quotes, including newlines and internal quotes
  let requestBody: any;
  const dataMatch = command.match(/(?:-d|--data(?:-raw)?)\s+['"](.+?)['"]\s*(?:--|\s*$)/s);
  if (dataMatch) {
    let bodyText = dataMatch[1].trim();

    // Clean up escaped quotes and newlines that might be in the JSON
    bodyText = bodyText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    try {
      // Try to parse as JSON
      requestBody = JSON.parse(bodyText);
    } catch {
      // If not JSON, store as string
      requestBody = bodyText;
    }
  }

  // Parse URL to extract path and query params
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname;

  // Extract query params from URL
  let queryParams: QueryParam[] | undefined;
  if (parsedUrl.search) {
    const params: QueryParam[] = [];
    parsedUrl.searchParams.forEach((value, key) => {
      params.push({ key, value });
    });
    if (params.length > 0) {
      queryParams = params;
    }
  }

  return {
    method,
    url,
    path,
    headers,
    requestBody,
    queryParams,
  };
}

/**
 * Parse multiple cURL commands separated by newlines
 */
export function parseMultipleCurls(curlCommands: string): ParsedCurl[] {
  // Split by 'curl' keyword (case insensitive) but keep the curl command intact
  const commands = curlCommands
    .split(/(?=curl\s+)/i)
    .map(cmd => cmd.trim())
    .filter(cmd => cmd.length > 0);

  return commands.map(parseCurl);
}
