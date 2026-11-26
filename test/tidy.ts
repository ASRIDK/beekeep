import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Gives a test run one temporary folder of its own, and removes it afterwards. */
export default function tidy() {
  const dir = mkdtempSync(join(tmpdir(), 'hive-tests-'));
  process.env.TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
