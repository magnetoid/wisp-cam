import { useState } from 'react';
import { REPORT_REASONS, type ReportReason } from '@shared/protocol.ts';

const REASON_LABELS: Record<ReportReason, { label: string; hint: string }> = {
  nudity: { label: 'Nudity or sexual content', hint: 'Immediate ban' },
  minor: { label: 'This person appears to be a minor', hint: 'Immediate ban, reviewed urgently' },
  illegal: { label: 'Illegal activity', hint: 'Immediate ban, may be reported to authorities' },
  harassment: { label: 'Harassment or hate', hint: 'Reviewed by a human' },
  spam: { label: 'Spam or advertising', hint: 'Reviewed by a human' },
  other: { label: 'Something else', hint: 'Reviewed by a human' },
};

interface ReportSheetProps {
  onSubmit: (reason: ReportReason, note?: string) => void;
  onCancel: () => void;
}

export default function ReportSheet({ onSubmit, onCancel }: ReportSheetProps) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');

  return (
    <div className="sheet-backdrop" onClick={onCancel} role="presentation">
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Report this person"
      >
        <h2 className="sheet__title">What happened?</h2>
        <p className="sheet__subtitle">
          Reporting ends this chat immediately. A snapshot of their video is attached as evidence.
        </p>

        <div className="sheet__options">
          {REPORT_REASONS.map((value) => (
            <button
              key={value}
              className={`reason ${reason === value ? 'reason--selected' : ''}`}
              onClick={() => setReason(value)}
              aria-pressed={reason === value}
            >
              <span className="reason__label">{REASON_LABELS[value].label}</span>
              <span className="reason__hint">{REASON_LABELS[value].hint}</span>
            </button>
          ))}
        </div>

        {reason && (
          <label className="field">
            <span className="field__label">Anything to add? (optional)</span>
            <textarea
              className="field__input field__input--area"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </label>
        )}

        <div className="sheet__actions">
          <button className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--danger"
            disabled={!reason}
            onClick={() => reason && onSubmit(reason, note.trim() || undefined)}
          >
            Submit report
          </button>
        </div>
      </div>
    </div>
  );
}
