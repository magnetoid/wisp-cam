import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/**
 * Minimal file-backed persistence. Two concerns only:
 *   - append-only JSONL for events we must keep for abuse handling
 *   - a small JSON snapshot for ban state, so bans survive a restart
 *
 * Deliberately not a database: the MVP's durable data is tiny, and keeping it
 * as flat files makes the retention/pruning story easy to audit.
 */

const dir = path.resolve(config.dataDir);

function ensureDir(): void {
  fs.mkdirSync(dir, { recursive: true });
}

ensureDir();

export function appendJsonl(file: string, record: unknown): void {
  const line = JSON.stringify({ ...(record as object), at: Date.now() }) + '\n';
  fs.appendFile(path.join(dir, file), line, (err) => {
    if (err) console.error(`[store] failed to append to ${file}:`, err.message);
  });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  const target = path.join(dir, file);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error(`[store] failed to write ${file}:`, (err as Error).message);
  }
}

/**
 * Drop JSONL records older than the retention window.
 *
 * Report records are exempt: material tied to a report may need to be
 * preserved for a legal-process response well beyond the metadata window.
 */
export function pruneJsonl(file: string, retentionDays: number): void {
  const target = path.join(dir, file);
  if (!fs.existsSync(target)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    const kept = fs
      .readFileSync(target, 'utf8')
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const rec = JSON.parse(line) as { at?: number };
          return typeof rec.at === 'number' && rec.at >= cutoff;
        } catch {
          return false;
        }
      });
    fs.writeFileSync(target, kept.length ? kept.join('\n') + '\n' : '');
    console.log(`[store] pruned ${file}, ${kept.length} records within retention`);
  } catch (err) {
    console.error(`[store] failed to prune ${file}:`, (err as Error).message);
  }
}

export const files = {
  /** Pairing metadata: who was matched with whom and when. Pruned. */
  pairings: 'pairings.jsonl',
  /** Session issuance: session id, IP, timestamp. Pruned. */
  sessions: 'sessions.jsonl',
  /** Abuse reports and their evidence. Not pruned automatically. */
  reports: 'reports.jsonl',
  /** Ban state snapshot. */
  bans: 'bans.json',
} as const;
