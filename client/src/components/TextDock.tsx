import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/useChat.ts';

interface TextDockProps {
  open: boolean;
  messages: ChatMessage[];
  canSend: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
  /** Text-only mode gives the dock the whole screen instead of a sheet. */
  fullHeight: boolean;
}

export default function TextDock({
  open,
  messages,
  canSend,
  onSend,
  onClose,
  fullHeight,
}: TextDockProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Pin to the newest message whenever one arrives.
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, open]);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    onSend(text);
    setDraft('');
  }

  return (
    <section
      className={`dock ${open ? 'dock--open' : ''} ${fullHeight ? 'dock--full' : ''}`}
      aria-hidden={!open}
      aria-label="Text chat"
    >
      {!fullHeight && (
        <button className="dock__grip" onClick={onClose} aria-label="Close chat">
          <span className="dock__grip-bar" />
        </button>
      )}

      <div className="dock__messages" ref={listRef}>
        {messages.length === 0 ? (
          <p className="dock__empty">
            {canSend ? 'Say something.' : 'Messages appear once you are connected.'}
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`bubble ${message.mine ? 'bubble--mine' : ''}`}>
              {message.text}
            </div>
          ))
        )}
      </div>

      <form className="dock__composer" onSubmit={submit}>
        <input
          className="dock__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={canSend ? 'Message' : 'Waiting for someone…'}
          disabled={!canSend}
          maxLength={2000}
          autoComplete="off"
          aria-label="Message"
        />
        <button className="dock__send" type="submit" disabled={!canSend || draft.trim() === ''}>
          Send
        </button>
      </form>
    </section>
  );
}
