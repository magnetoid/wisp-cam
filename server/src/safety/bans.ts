import { config } from '../config.ts';
import { files, readJson, writeJson } from '../store.ts';

interface BanRecord {
  /** Number of offences recorded against this IP. Drives the escalation ladder. */
  offences: number;
  /** Epoch ms the ban lifts, or null for permanent. */
  until: number | null;
  reason: string;
}

/**
 * IP-keyed bans with an escalating ladder: 15 minutes, then 24 hours, then
 * permanent. IP bans are leaky by design (VPNs defeat them) — the goal is
 * raising friction for casual abusers, not perfect exclusion.
 */
const bans = new Map<string, BanRecord>(Object.entries(readJson<Record<string, BanRecord>>(files.bans, {})));

function persist(): void {
  writeJson(files.bans, Object.fromEntries(bans));
}

export interface BanStatus {
  banned: boolean;
  until: number | null;
  reason: string;
}

export function checkBan(ip: string): BanStatus {
  const record = bans.get(ip);
  if (!record) return { banned: false, until: null, reason: '' };

  if (record.until !== null && record.until <= Date.now()) {
    // Ban expired. Keep the offence count so the next one escalates.
    record.until = 0;
    return { banned: false, until: null, reason: '' };
  }
  if (record.until === 0) return { banned: false, until: null, reason: '' };

  return { banned: true, until: record.until, reason: record.reason };
}

export function recordOffence(ip: string, reason: string): BanStatus {
  const existing = bans.get(ip);
  const offences = (existing?.offences ?? 0) + 1;
  const ladder = config.bans.ladderMs;

  const until = offences > ladder.length ? null : Date.now() + ladder[offences - 1]!;

  const record: BanRecord = { offences, until, reason };
  bans.set(ip, record);
  persist();

  console.warn(
    `[ban] ip=${maskIp(ip)} offence#${offences} reason=${reason} until=${
      until === null ? 'permanent' : new Date(until).toISOString()
    }`,
  );

  return { banned: true, until, reason };
}

/** Log-safe IP rendering: enough to correlate, not a full address in plaintext logs. */
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + ':…';
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : ip;
}
