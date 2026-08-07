import { useEffect } from 'react';
import { useChat } from '../lib/useChat.ts';
import { clearStoredSession } from '../lib/api.ts';
import { preloadNsfwModel } from '../lib/nsfw.ts';
import ChatView from './ChatView.tsx';

interface ChatShellProps {
  token: string;
  onSessionLost: () => void;
}

export default function ChatShell({ token, onSessionLost }: ChatShellProps) {
  const chat = useChat(token);

  useEffect(() => {
    if (chat.banned) clearStoredSession();
  }, [chat.banned]);

  if (chat.banned) {
    const until = chat.banned.until ? new Date(chat.banned.until) : null;
    return (
      <main className="centered">
        <div className="panel">
          <h1 className="panel__title">Access suspended</h1>
          <p className="panel__body">
            {until
              ? `Your access is suspended until ${until.toLocaleString()}.`
              : 'Your access to this service has been permanently suspended.'}
          </p>
          <p className="panel__body panel__body--muted">
            This usually follows a report or an automatic detection of nudity on camera. If you
            believe this is a mistake, contact us using the abuse address in the terms.
          </p>
          <a className="button" href="#/terms">
            Read the terms
          </a>
        </div>
      </main>
    );
  }

  if (chat.status === 'idle' || chat.status === 'requesting-media') {
    return (
      <main className="centered">
        <div className="panel">
          <h1 className="panel__title">How do you want to talk?</h1>

          {chat.mediaError && (
            <p className="alert" role="alert">
              {chat.mediaError}
            </p>
          )}

          <div className="mode-choice">
            <button
              className="mode-card"
              onClick={() => {
                // Start fetching the screening model now, in parallel with the
                // camera prompt and the queue wait.
                preloadNsfwModel();
                void chat.start('video');
              }}
              disabled={chat.status === 'requesting-media'}
            >
              <span className="mode-card__icon" aria-hidden="true">
                ◉
              </span>
              <span className="mode-card__label">Video</span>
              <span className="mode-card__hint">
                {chat.status === 'requesting-media'
                  ? 'Waiting for camera…'
                  : 'Camera and mic, peer-to-peer'}
              </span>
            </button>

            <button className="mode-card" onClick={() => void chat.start('text')}>
              <span className="mode-card__icon" aria-hidden="true">
                ✎
              </span>
              <span className="mode-card__label">Text only</span>
              <span className="mode-card__hint">No camera needed</span>
            </button>
          </div>

          <button className="link-button" onClick={onSessionLost}>
            Leave
          </button>
        </div>
      </main>
    );
  }

  return <ChatView chat={chat} />;
}
