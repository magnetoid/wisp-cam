import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';
import { MAX_CHAT_LENGTH, type ChatBlockReason } from '../../../shared/protocol.ts';

const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * Contact-info patterns. These exist to blunt off-platform luring and spam,
 * which is the dominant text abuse on anonymous chat. They are trivially
 * evadable (spaced-out digits, homoglyphs) — reports and bans are the real
 * backstop; this just removes the low-effort majority.
 */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|gg|ly|co|xyz|link|onion)\b/i;
const PHONE_PATTERN = /(?:\+?\d[\s().-]{0,2}){7,}\d/;
const HANDLE_PATTERN =
  /\b(?:snap(?:chat)?|insta(?:gram)?|telegram|whats\s?app|kik|discord|tiktok|onlyfans|of)\b[\s:@-]*[a-z0-9._-]{3,}/i;
const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

export type FilterResult =
  | { ok: true; text: string }
  | { ok: false; reason: ChatBlockReason };

export function filterMessage(raw: unknown): FilterResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'too-long' };

  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > MAX_CHAT_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }

  if (URL_PATTERN.test(text)) return { ok: false, reason: 'link' };
  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text) || HANDLE_PATTERN.test(text)) {
    return { ok: false, reason: 'contact-info' };
  }
  if (profanityMatcher.hasMatch(text)) return { ok: false, reason: 'profanity' };

  return { ok: true, text };
}
