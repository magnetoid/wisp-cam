import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.ts';
import { MIN_AGE_YEARS } from '../../shared/protocol.ts';

export interface SessionClaims {
  /** Random per-session id. Not linked to any account — there are no accounts. */
  sid: string;
  iat: number;
  exp: number;
}

export function issueSessionToken(): { token: string; sessionId: string; expiresAt: number } {
  const sessionId = crypto.randomUUID();
  const expiresIn = config.sessionTtlSeconds;
  const token = jwt.sign({ sid: sessionId }, config.jwtSecret, { expiresIn });
  return { token, sessionId, expiresAt: Date.now() + expiresIn * 1000 };
}

export function verifySessionToken(token: string): SessionClaims | null {
  try {
    return jwt.verify(token, config.jwtSecret) as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Neutral age gate. The client asks for a date of birth with no leading
 * default; we recompute the age here so editing the client cannot bypass it.
 *
 * Self-declaration is not "highly effective age assurance" under the UK Online
 * Safety Act — see README's open-risks section.
 */
export function meetsAgeRequirement(birthDate: unknown): boolean {
  if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return false;

  const dob = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return false;

  const now = new Date();
  if (dob > now) return false;

  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;

  return age >= MIN_AGE_YEARS && age < 120;
}

/** Verifies a Cloudflare Turnstile token. Skipped when Turnstile is unconfigured. */
export async function verifyTurnstile(token: unknown, ip: string): Promise<boolean> {
  if (!config.turnstileSecret) return true; // dev mode: no bot gate configured

  if (typeof token !== 'string' || token.length === 0) return false;

  try {
    const body = new URLSearchParams({
      secret: config.turnstileSecret,
      response: token,
      remoteip: ip,
    });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] verification failed:', (err as Error).message);
    return false;
  }
}
