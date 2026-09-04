import * as path from 'node:path';
import {
  cleanupTestStorage,
  getTestStorageRoot,
} from './test-support/test-storage';

const root = getTestStorageRoot();
const fakeHome = path.join(root, 'home');
const dataDir = path.join(fakeHome, '.mockmate');

process.env.MOCKMATE_DATA_DIR = dataDir;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

cleanupTestStorage();
