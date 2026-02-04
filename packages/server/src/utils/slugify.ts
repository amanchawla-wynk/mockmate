/**
 * Utility functions for generating slugs and filenames
 */

/**
 * Convert a project name to a URL-safe slug
 * @param name - Project name
 * @returns URL-safe slug
 * @example slugify("Xstream Play") => "xstream-play"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove non-word chars (except spaces and hyphens)
    .replace(/[\s_]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Generate a filename for a resource based on method and path
 * @param method - HTTP method
 * @param path - URL path
 * @returns Filename safe string
 * @example generateResourceFilename("GET", "/api/users/:id") => "GET_api_users_id.json"
 */
export function generateResourceFilename(method: string, path: string): string {
  // Remove leading slash and convert path params to plain text
  const cleanPath = path
    .replace(/^\//, '') // Remove leading slash
    .replace(/:/g, '') // Remove colons from params
    .replace(/\//g, '_') // Replace slashes with underscores
    .replace(/[^\w-]/g, '_'); // Replace other special chars with underscores

  return `${method}_${cleanPath}.json`;
}

/**
 * Parse a resource filename back to method and path
 * @param filename - Resource filename
 * @returns Object with method and path, or null if invalid
 * @example parseResourceFilename("GET_api_users_id.json") => { method: "GET", path: "api_users_id" }
 */
export function parseResourceFilename(filename: string): { method: string; path: string } | null {
  // Remove .json extension
  const nameWithoutExt = filename.replace(/\.json$/, '');

  // Split on first underscore
  const firstUnderscoreIndex = nameWithoutExt.indexOf('_');
  if (firstUnderscoreIndex === -1) {
    return null;
  }

  const method = nameWithoutExt.substring(0, firstUnderscoreIndex);
  const path = nameWithoutExt.substring(firstUnderscoreIndex + 1);

  return { method, path };
}

/**
 * Generate a unique ID with a prefix
 * @param prefix - Prefix for the ID (e.g., "proj", "res", "log")
 * @returns Unique ID
 * @example generateId("proj") => "proj_1704067200000_abc123"
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}
