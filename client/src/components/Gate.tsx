import { useEffect, useRef, useState } from 'react';
import { ApiError, createSession, fetchPublicConfig, type PublicConfig } from '../lib/api.ts';

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: { sitekey: string; callback: (token: string) => void; theme?: string; size?: string },
  ) => string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface GateProps {
  onSession: (token: string) => void;
}

/**
 * The entry gate: house rules, a neutral date-of-birth age check, and the bot
 * challenge. The age check is deliberately an empty date field with no leading
 * default — a pre-filled or "are you 18?" style prompt tells the user which
 * answer unlocks the door.
 */
export default function Gate({ onSession }: GateProps) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [birthDate, setBirthDate] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);

  useEffect(() => {
    void fetchPublicConfig().then(setConfig);
  }, []);

  useEffect(() => {
    const siteKey = config?.turnstileSiteKey;
    if (!siteKey || rendered.current) return;

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      if (!turnstileRef.current || rendered.current || !window.turnstile) return;
      rendered.current = true;
      window.turnstile.render(turnstileRef.current, {
        sitekey: siteKey,
        theme: 'dark',
        size: 'flexible',
        callback: setTurnstileToken,
      });
    };
    document.head.appendChild(script);
  }, [config?.turnstileSiteKey]);

  const needsTurnstile = Boolean(config?.turnstileSiteKey);
  const canSubmit =
    accepted && birthDate !== '' && (!needsTurnstile || turnstileToken !== null) && !submitting;

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      const token = await createSession({
        birthDate,
        turnstileToken: turnstileToken ?? undefined,
      });
      onSession(token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate__inner">
        <header className="gate__header">
          <h1 className="gate__title">
            talk to
            <br />
            <span className="gate__title-accent">someone new</span>
          </h1>
          <p className="gate__subtitle">
            One-on-one video or text with a stranger. No accounts, no chat history.
            Swipe up whenever you want someone else.
          </p>
        </header>

        <section className="rules" aria-label="House rules">
          <h2 className="rules__heading">Before you start</h2>
          <ul className="rules__list">
            <li>
              <strong>18+ only.</strong> This service is for adults.
            </li>
            <li>
              <strong>Keep your clothes on.</strong> Nudity and sexual content get you banned
              automatically.
            </li>
            <li>
              <strong>Report anything harmful.</strong> Illegal content is reported to the
              authorities.
            </li>
            <li>
              <strong>Video is peer-to-peer.</strong> It goes straight to the other person and is
              never recorded by us.
            </li>
          </ul>
        </section>

        <form className="gate__form" onSubmit={handleSubmit}>
          <label className="field">
            <span className="field__label">Your date of birth</span>
            <input
              className="field__input"
              type="date"
              value={birthDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setBirthDate(e.target.value)}
              required
              aria-describedby="dob-help"
            />
            <span className="field__help" id="dob-help">
              We don&apos;t store this. It is checked once to confirm you&apos;re 18 or older.
            </span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              I&apos;m 18 or older and I accept the <a href="#/terms">terms</a> and{' '}
              <a href="#/privacy">privacy policy</a>.
            </span>
          </label>

          {needsTurnstile && <div className="turnstile" ref={turnstileRef} />}

          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}

          <button className="button button--primary button--lg" type="submit" disabled={!canSubmit}>
            {submitting ? 'Starting…' : 'Enter'}
          </button>
        </form>

        <footer className="gate__footer">
          <a href="#/terms">Terms</a>
          <span aria-hidden="true">·</span>
          <a href="#/privacy">Privacy</a>
          {config && (
            <>
              <span aria-hidden="true">·</span>
              <a href={`mailto:${config.abuseContactEmail}`}>Report abuse</a>
            </>
          )}
        </footer>
      </div>
    </main>
  );
}
