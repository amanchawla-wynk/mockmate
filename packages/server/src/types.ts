export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface QueryParam {
  key: string;
  value: string;
  description?: string;
}

export interface GlobalConfig {
  server?: {
    httpPort?: number;
    httpsPort?: number;
    proxyPort?: number;
  };
}

export interface StorageConfig {
  baseDir: string;
  certsDir: string;
  configFile: string;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
  path?: string;
  details?: unknown;
  recovery?: string;
  requestId: string;
}
