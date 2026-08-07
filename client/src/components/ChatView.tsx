import { useEffect, useRef, useState } from 'react';
import type { ChatController } from '../lib/useChat.ts';
import { captureFrame, startNsfwMonitor } from '../lib/nsfw.ts';
import { useSwipeUp } from '../lib/useSwipe.ts';
import ReportSheet from './ReportSheet.tsx';
import TextDock from './TextDock.tsx';

interface ChatViewProps {
  chat: ChatController;
}

export default function ChatView({ chat }: ChatViewProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const [showReport, setShowReport] = useState(false);
  const [textOpen, setTextOpen] = useState(chat.mode === 'text');
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  const isLive = chat.status === 'connected';
  const isVideo = chat.mode === 'video';

  // Swipe up anywhere on the stage to move on. This is the primary gesture on
  // mobile; the Next button covers desktop and accessibility.
  const swipe = useSwipeUp<HTMLDivElement>({
    onSwipeUp: chat.next,
    enabled: chat.status === 'connected' || chat.status === 'connecting',
  });

  useEffect(() => {
    if (localVideoRef.current && chat.localStream) {
      localVideoRef.current.srcObject = chat.localStream;
    }
  }, [chat.localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = chat.remoteStream;
    }
  }, [chat.remoteStream]);

  // Screen our own camera. Bypassable by design-aware users — reports and
  // server-side bans are the real backstop.
  useEffect(() => {
    const video = localVideoRef.current;
    if (!isVideo || !video || !chat.localStream) return;

    const monitor = startNsfwMonitor({
      video,
      onViolation: (score) => {
        console.warn(`[nsfw] local camera flagged at ${score.toFixed(2)}`);
        chat.selfReportNsfw();
      },
    });
    return () => monitor.stop();
  }, [isVideo, chat.localStream, chat.selfReportNsfw]);

  function handleReport(reason: Parameters<ChatController['report']>[0], note?: string): void {
    // Capture the remote frame as evidence at the moment of the report only.
    const snapshot = remoteVideoRef.current ? captureFrame(remoteVideoRef.current) : undefined;
    chat.report(reason, note, snapshot);
    setShowReport(false);
  }

  return (
    <div className="stage-wrap">
      <div
        className="stage"
        ref={swipe.ref}
        style={{
          transform: `translateY(${swipe.offset}px)`,
          transition: swipe.dragging ? 'none' : 'transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        }}
      >
        {isVideo ? (
          <video
            className="stage__remote"
            ref={remoteVideoRef}
            autoPlay
            playsInline
            aria-label="Video from the person you are talking to"
          />
        ) : (
          <div className="stage__remote stage__remote--text" aria-hidden="true" />
        )}

        {!isLive && (
          <div className="searching">
            <div className="searching__pulse" aria-hidden="true" />
            <p className="searching__label">
              {chat.status === 'connecting' ? 'Connecting…' : 'Looking for someone…'}
            </p>
            {chat.status === 'searching' && chat.queuePosition > 1 && (
              <p className="searching__meta">#{chat.queuePosition} in line</p>
            )}
          </div>
        )}

        <header className="topbar">
          <span className={`pill ${isLive ? 'pill--live' : ''}`}>
            {isLive ? 'Connected' : chat.status === 'connecting' ? 'Connecting' : 'Searching'}
          </span>
          <div className="topbar__actions">
            <button
              className="icon-button icon-button--danger"
              onClick={() => setShowReport(true)}
              disabled={!isLive}
              aria-label="Report this person"
            >
              Report
            </button>
            <button className="icon-button" onClick={chat.stop} aria-label="Stop chatting">
              Stop
            </button>
          </div>
        </header>

        {isVideo && (
          <video
            className={`self-view ${cameraOn ? '' : 'self-view--off'}`}
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            aria-label="Your own camera"
          />
        )}

        <div className="notices" role="status" aria-live="polite">
          {chat.notices.map((notice) => (
            <div key={notice.id} className={`notice notice--${notice.tone}`}>
              {notice.text}
            </div>
          ))}
        </div>

        {isLive && (
          <div className="swipe-hint" aria-hidden="true">
            <span className="swipe-hint__chevron">⌃</span>
            <span>Swipe up for someone new</span>
          </div>
        )}

        <nav className="controls">
          {isVideo && (
            <>
              <button
                className={`control ${cameraOn ? '' : 'control--off'}`}
                onClick={() => {
                  const next = !cameraOn;
                  setCameraOn(next);
                  chat.toggleCamera(next);
                }}
                aria-pressed={!cameraOn}
                aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
              >
                {cameraOn ? 'Cam' : 'Cam off'}
              </button>
              <button
                className={`control ${micOn ? '' : 'control--off'}`}
                onClick={() => {
                  const next = !micOn;
                  setMicOn(next);
                  chat.toggleMic(next);
                }}
                aria-pressed={!micOn}
                aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
              >
                {micOn ? 'Mic' : 'Mic off'}
              </button>
            </>
          )}

          <button className="control control--primary" onClick={chat.next} aria-label="Next person">
            Next ↑
          </button>

          <button
            className={`control ${textOpen ? 'control--active' : ''}`}
            onClick={() => setTextOpen((open) => !open)}
            aria-expanded={textOpen}
            aria-label="Toggle chat messages"
          >
            Chat
            {chat.messages.length > 0 && !textOpen && (
              <span className="control__badge">{chat.messages.length}</span>
            )}
          </button>
        </nav>
      </div>

      <TextDock
        open={textOpen}
        messages={chat.messages}
        canSend={isLive}
        onSend={chat.sendMessage}
        onClose={() => setTextOpen(false)}
        fullHeight={!isVideo}
      />

      {showReport && (
        <ReportSheet onSubmit={handleReport} onCancel={() => setShowReport(false)} />
      )}
    </div>
  );
}
