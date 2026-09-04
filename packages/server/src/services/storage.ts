import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GlobalConfig, StorageConfig } from '../types';

export function isStablePathSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !path.isAbsolute(value)
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

export function getStorageConfig(): StorageConfig {
  const baseDir = process.env.MOCKMATE_DATA_DIR
    ? path.resolve(process.env.MOCKMATE_DATA_DIR)
    : path.join(os.homedir(), '.mockmate');
  return {
    baseDir,
    certsDir: path.join(baseDir, 'certs'),
    configFile: path.join(baseDir, 'config.json'),
  };
}

export function readConfig(): GlobalConfig {
  const { baseDir, configFile } = getStorageConfig();
  fs.mkdirSync(baseDir, { recursive: true });
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8')) as GlobalConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const config: GlobalConfig = {
      server: { httpPort: 3456, httpsPort: 3457, proxyPort: 8888 },
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    return config;
  }
}
