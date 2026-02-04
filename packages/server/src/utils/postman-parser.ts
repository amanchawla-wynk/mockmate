/**
 * Parse Postman collections into resource definitions
 */

import type { HttpMethod, QueryParam } from '../types';

export interface PostmanCollection {
  info: {
    name: string;
    description?: string;
    schema: string;
  };
  item: PostmanItem[];
  variable?: PostmanVariable[];
}

export interface PostmanItem {
  name: string;
  request: PostmanRequest | string;
  response?: any[];
  item?: PostmanItem[]; // For folders
}

export interface PostmanRequest {
  method: string;
  header?: PostmanHeader[];
  body?: PostmanBody;
  url: PostmanUrl | string;
  description?: string;
}

export interface PostmanHeader {
  key: string;
  value: string;
  disabled?: boolean;
}

export interface PostmanBody {
  mode: string;
  raw?: string;
  urlencoded?: Array<{ key: string; value: string; disabled?: boolean }>;
  formdata?: Array<{ key: string; value: string; type?: string; disabled?: boolean }>;
}

export interface PostmanUrl {
  raw: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: Array<{ key: string; value: string; disabled?: boolean }>;
}

export interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
}

export interface ParsedPostmanRequest {
  name: string;
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  requestBody?: any;
  queryParams?: QueryParam[];
  description?: string;
}

/**
 * Normalize HTTP method to our supported methods
 */
function normalizeMethod(method: string): HttpMethod {
  const normalized = method.toUpperCase();
  if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(normalized)) {
    return normalized as HttpMethod;
  }
  // Default to GET for unsupported methods
  return 'GET';
}

/**
 * Replace Postman variables in a string
 * {{variableName}} -> :variableName (for path params)
 * {{baseUrl}} and other base URLs -> removed
 */
function replaceVariables(str: string, inPath = false): string {
  if (!str) return str;

  // Remove {{baseUrl}} or similar base URL variables
  str = str.replace(/\{\{baseUrl\}\}/gi, '');
  str = str.replace(/\{\{apiUrl\}\}/gi, '');
  str = str.replace(/\{\{url\}\}/gi, '');
  str = str.replace(/\{\{host\}\}/gi, '');

  // For paths, convert {{variable}} to :variable (path parameters)
  if (inPath) {
    str = str.replace(/\{\{([^}]+)\}\}/g, ':$1');
  } else {
    // For headers/values, remove the variable markers but keep a placeholder
    str = str.replace(/\{\{([^}]+)\}\}/g, '<$1>');
  }

  return str;
}

/**
 * Extract path from Postman URL
 */
function extractPath(url: PostmanUrl | string): string {
  if (typeof url === 'string') {
    // Replace variables first
    const cleanUrl = replaceVariables(url, false);

    try {
      const parsed = new URL(cleanUrl);
      return replaceVariables(parsed.pathname, true);
    } catch {
      // If URL parsing fails, try to extract path
      const pathMatch = cleanUrl.match(/https?:\/\/[^\/]+(.+)/);
      if (pathMatch) {
        return replaceVariables(pathMatch[1].split('?')[0], true); // Remove query params
      }
      // No protocol, might just be a path
      const pathOnly = cleanUrl.split('?')[0]; // Remove query params
      return replaceVariables(pathOnly.startsWith('/') ? pathOnly : '/' + pathOnly, true);
    }
  }

  // Construct path from parts
  let path = '/';
  if (url.path && url.path.length > 0) {
    // Join path parts and replace variables
    const pathStr = url.path
      .map(part => replaceVariables(part, true))
      .join('/');
    path = '/' + pathStr;
  }

  // Don't include query parameters - they're usually dynamic and can be added manually

  return path;
}

/**
 * Parse Postman request body
 */
function parseBody(body?: PostmanBody): any {
  if (!body) return undefined;

  switch (body.mode) {
    case 'raw':
      if (body.raw) {
        try {
          return JSON.parse(body.raw);
        } catch {
          return body.raw;
        }
      }
      return undefined;

    case 'urlencoded':
      if (body.urlencoded) {
        const obj: Record<string, string> = {};
        body.urlencoded.forEach(item => {
          if (!item.disabled) {
            obj[item.key] = item.value;
          }
        });
        return obj;
      }
      return undefined;

    case 'formdata':
      if (body.formdata) {
        const obj: Record<string, string> = {};
        body.formdata.forEach(item => {
          if (!item.disabled && item.type !== 'file') {
            obj[item.key] = item.value;
          }
        });
        return obj;
      }
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Parse a single Postman request item
 */
function parsePostmanRequest(item: PostmanItem): ParsedPostmanRequest | null {
  // Skip if this is a folder
  if (item.item) {
    return null;
  }

  // Skip if request is just a string (shouldn't happen in valid collections)
  if (typeof item.request === 'string') {
    return null;
  }

  const request = item.request;

  // Extract headers and clean up variables
  const headers: Record<string, string> = {};
  if (request.header) {
    request.header.forEach(h => {
      if (!h.disabled) {
        // Replace variables in all headers (including Authorization)
        headers[h.key] = replaceVariables(h.value, false);
      }
    });
  }

  // Extract query params from URL
  let queryParams: QueryParam[] | undefined;
  if (typeof request.url !== 'string' && request.url.query) {
    const params = request.url.query
      .filter(q => !q.disabled)
      .map(q => ({
        key: q.key,
        value: replaceVariables(q.value, false),
      }));

    if (params.length > 0) {
      queryParams = params;
    }
  }

  return {
    name: item.name,
    method: normalizeMethod(request.method),
    path: extractPath(request.url),
    headers,
    requestBody: parseBody(request.body),
    queryParams,
    description: request.description,
  };
}

/**
 * Recursively extract all requests from collection items (including folders)
 */
function extractAllRequests(items: PostmanItem[]): ParsedPostmanRequest[] {
  const requests: ParsedPostmanRequest[] = [];

  for (const item of items) {
    if (item.item) {
      // This is a folder, recurse into it
      requests.push(...extractAllRequests(item.item));
    } else {
      // This is a request
      const parsed = parsePostmanRequest(item);
      if (parsed) {
        requests.push(parsed);
      }
    }
  }

  return requests;
}

/**
 * Parse a Postman collection JSON
 */
export function parsePostmanCollection(collectionJson: string | PostmanCollection): {
  name: string;
  description?: string;
  requests: ParsedPostmanRequest[];
} {
  let collection: PostmanCollection;

  if (typeof collectionJson === 'string') {
    try {
      collection = JSON.parse(collectionJson);
    } catch (error) {
      throw new Error('Invalid JSON: Could not parse Postman collection');
    }
  } else {
    collection = collectionJson;
  }

  // Validate it's a Postman collection
  if (!collection.info || !collection.item) {
    throw new Error('Invalid Postman collection: Missing required fields');
  }

  // Extract all requests from the collection
  const requests = extractAllRequests(collection.item);

  return {
    name: collection.info.name,
    description: collection.info.description,
    requests,
  };
}
