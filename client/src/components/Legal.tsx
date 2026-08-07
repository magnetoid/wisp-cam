import { useEffect, useState } from 'react';
import { fetchPublicConfig, type PublicConfig } from '../lib/api.ts';

interface LegalProps {
  page: 'terms' | 'privacy';
}

/**
 * Terms and privacy text. These are a starting point written to match what the
 * service actually does — they are not legal advice, and should be reviewed by
 * a lawyer before a public launch. See README's open-risks section.
 */
export default function Legal({ page }: LegalProps) {
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    void fetchPublicConfig().then(setConfig);
  }, []);

  const contact = config?.abuseContactEmail ?? 'abuse@example.com';
  const retention = config?.logRetentionDays ?? 30;

  return (
    <main className="prose">
      <a className="prose__back" href="#/">
        ← Back
      </a>

      {page === 'terms' ? (
        <>
          <h1>Terms of use</h1>
          <p className="prose__lede">
            By using this service you agree to these terms. If you do not agree, do not use it.
          </p>

          <h2>You must be 18 or older</h2>
          <p>
            This service randomly connects adults for one-on-one conversation. You confirm you are
            at least 18 years old. Accounts do not exist here, so we rely on your declaration and on
            automated and human review to keep minors off the service.
          </p>

          <h2>What is not allowed</h2>
          <ul>
            <li>Nudity, sexual activity, or sexual content of any kind.</li>
            <li>Any sexual content involving minors, in any form. This is reported to authorities.</li>
            <li>Harassment, hate speech, threats, or targeting individuals.</li>
            <li>Recording or redistributing another person without their knowledge.</li>
            <li>Spam, advertising, soliciting, or driving people to other platforms.</li>
            <li>Automated access, scraping, or interfering with the service.</li>
          </ul>

          <h2>Enforcement</h2>
          <p>
            Your camera is screened automatically on your own device, and other users can report
            you. Violations result in a temporary suspension, escalating to a permanent one. We do
            not owe you notice or an appeal, though you may write to us at the address below.
          </p>

          <h2>Child sexual abuse material</h2>
          <p>
            We report apparent child sexual abuse material, child sex trafficking, and enticement of
            minors to the National Center for Missing &amp; Exploited Children (NCMEC) as required by
            law, and preserve the associated material for the statutory period. There is no
            exception to this and no anonymity for it.
          </p>

          <h2>No warranty</h2>
          <p>
            The service is provided as-is. Other users are strangers and we do not vet them. You are
            responsible for what you show and say, and for deciding whether to continue any
            conversation. Move on at any time by swiping up.
          </p>

          <h2>Contact</h2>
          <p>
            Abuse reports and legal requests: <a href={`mailto:${contact}`}>{contact}</a>
          </p>
        </>
      ) : (
        <>
          <h1>Privacy policy</h1>
          <p className="prose__lede">
            The short version: your video and audio never touch our servers, we never store your
            messages, and we keep a small amount of connection metadata for a short time so we can
            act on abuse.
          </p>

          <h2>What we do not collect</h2>
          <ul>
            <li>
              <strong>Your video and audio.</strong> These flow directly between you and the other
              person (peer-to-peer). We never see, store, or record them. When a direct connection
              is impossible, traffic is relayed through an encrypted TURN relay that passes it
              through without storing it.
            </li>
            <li>
              <strong>Your messages.</strong> Text passes through our server so it can be filtered
              for spam and abuse, and is discarded immediately. It is never written to disk.
            </li>
            <li>
              <strong>Accounts or profiles.</strong> There are none. We do not ask for your name,
              email, or phone number.
            </li>
            <li>
              <strong>Your date of birth.</strong> It is checked once to confirm you are 18 or older
              and is not stored.
            </li>
          </ul>

          <h2>What we do collect</h2>
          <ul>
            <li>
              <strong>Your IP address and a random session identifier</strong>, with timestamps.
            </li>
            <li>
              <strong>Pairing metadata:</strong> which sessions were connected to each other and
              when. This is what lets us act when you report the person you just spoke to.
            </li>
            <li>
              <strong>Reports and their evidence.</strong> When someone files a report, we store the
              reason, the sessions and IP addresses involved, and a single still frame from the
              reported person&apos;s video.
            </li>
            <li>
              <strong>Suspension records</strong> for enforcement.
            </li>
          </ul>

          <h2>Why, and for how long</h2>
          <p>
            The lawful basis is our legitimate interest in preventing abuse and keeping the service
            safe and secure (GDPR Article 6(1)(f)). Connection and pairing metadata is deleted
            automatically after {retention} days. Reports, their evidence, and suspension records
            are kept longer because they may be needed to respond to legal process or to enforce a
            ban; material reported to NCMEC is preserved for the period the law requires.
          </p>

          <h2>Who we share it with</h2>
          <p>
            Nobody, except: law enforcement where we are legally required or where we report
            suspected crimes against children, and our hosting and network providers, who process
            traffic on our behalf.
          </p>

          <h2>Your rights</h2>
          <p>
            You can ask what we hold about you and ask us to delete it, by writing to{' '}
            <a href={`mailto:${contact}`}>{contact}</a>. Because we hold so little and it is tied to
            an IP address and a random session id, you may need to tell us roughly when you used the
            service. We may refuse deletion where the data is needed to handle abuse or to establish
            or defend legal claims.
          </p>

          <h2>Cookies and storage</h2>
          <p>
            We store a short-lived session token in your browser so you do not have to pass the
            entry check on every page load. It expires on its own and is cleared when you close the
            tab. We use no advertising or analytics trackers.
          </p>
        </>
      )}

      <p className="prose__updated">Last updated: 7 August 2026</p>
    </main>
  );
}
