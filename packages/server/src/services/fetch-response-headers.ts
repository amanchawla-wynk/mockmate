import type { ResponseHeaders } from '../domain/model';

export function responseHeadersFromFetch(
  headers: Headers,
  excludedHeaders?: ReadonlySet<string>,
): ResponseHeaders {
  const responseHeaders: ResponseHeaders = {};
  headers.forEach((value, name) => {
    if (!excludedHeaders?.has(name.toLowerCase())) responseHeaders[name] = value;
  });

  const getSetCookie = (headers as typeof headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  const cookies = getSetCookie?.call(headers);
  if (cookies?.length && !excludedHeaders?.has('set-cookie')) {
    responseHeaders['set-cookie'] = cookies;
  }
  return responseHeaders;
}
