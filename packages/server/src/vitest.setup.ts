import * as os from 'os';
import * as path from 'path';

// Isolate MockMate storage between test workers to avoid cross-test
// interference via ~/.mockmate.
const workerId = process.env.VITEST_WORKER_ID || '0';
const baseDir = path.join(os.tmpdir(), `mockmate-vitest-${process.pid}-${workerId}`);

process.env.MOCKMATE_DATA_DIR = baseDir;
