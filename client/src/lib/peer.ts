import type { RTCIceCandidateInitLike, RTCSessionDescriptionInitLike } from '@shared/protocol.ts';

export type PeerState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface PeerSessionOptions {
  iceServers: RTCIceServer[];
  /** Null in text-only mode: we still build a connection for state parity. */
  localStream: MediaStream | null;
  /** Exactly one side offers. The server decides, so glare cannot happen. */
  isInitiator: boolean;
  onDescription: (description: RTCSessionDescriptionInitLike) => void;
  onCandidate: (candidate: RTCIceCandidateInitLike) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onStateChange: (state: PeerState) => void;
}

/**
 * Wraps one RTCPeerConnection for the lifetime of one pairing.
 *
 * A session is never reused across matches: `close()` and build a new one.
 * Reusing a connection across partners is the single most common source of
 * wedged state in random-chat apps.
 */
export class PeerSession {
  private pc: RTCPeerConnection;
  private remoteStream = new MediaStream();
  /** Candidates that arrive before the remote description is applied. */
  private pendingCandidates: RTCIceCandidateInitLike[] = [];
  private hasRemoteDescription = false;
  private closed = false;

  constructor(private readonly opts: PeerSessionOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 4,
    });

    if (opts.localStream) {
      for (const track of opts.localStream.getTracks()) {
        this.pc.addTrack(track, opts.localStream);
      }
    } else {
      // Text-only: declare intent to receive nothing, but keep a media section
      // so both sides negotiate identically.
      this.pc.addTransceiver('audio', { direction: 'inactive' });
    }

    this.pc.onicecandidate = (event) => {
      if (event.candidate && !this.closed) {
        opts.onCandidate(event.candidate.toJSON() as RTCIceCandidateInitLike);
      }
    };

    this.pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!this.remoteStream.getTracks().includes(track)) this.remoteStream.addTrack(track);
      }
      opts.onRemoteStream(this.remoteStream);
    };

    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = this.pc.connectionState;
      if (state === 'connected') opts.onStateChange('connected');
      else if (state === 'connecting' || state === 'new') opts.onStateChange('connecting');
      else if (state === 'failed') opts.onStateChange('failed');
      else if (state === 'closed' || state === 'disconnected') opts.onStateChange('closed');
    };
  }

  /** The initiator calls this immediately; the responder waits for the offer. */
  async start(): Promise<void> {
    if (!this.opts.isInitiator || this.closed) return;
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: this.opts.localStream !== null,
    });
    await this.pc.setLocalDescription(offer);
    if (!this.closed && this.pc.localDescription) {
      this.opts.onDescription(this.pc.localDescription.toJSON() as RTCSessionDescriptionInitLike);
    }
  }

  async handleDescription(description: RTCSessionDescriptionInitLike): Promise<void> {
    if (this.closed) return;

    await this.pc.setRemoteDescription(description as RTCSessionDescriptionInit);
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();

    if (description.type === 'offer') {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      if (!this.closed && this.pc.localDescription) {
        this.opts.onDescription(this.pc.localDescription.toJSON() as RTCSessionDescriptionInitLike);
      }
    }
  }

  async handleCandidate(candidate: RTCIceCandidateInitLike): Promise<void> {
    if (this.closed) return;

    // Trickle ICE means candidates routinely beat the description across the
    // wire; hold them until there is somewhere to put them.
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch (err) {
      console.warn('[peer] failed to add ICE candidate:', err);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate as RTCIceCandidateInit);
      } catch (err) {
        console.warn('[peer] failed to add queued ICE candidate:', err);
      }
    }
  }

  /** Which candidate pair won — useful for confirming TURN actually works. */
  async selectedCandidateType(): Promise<string | null> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | null = null;
      stats.forEach((report) => {
        if (report.type === 'transport' && 'selectedCandidatePairId' in report) {
          pairId = (report as { selectedCandidatePairId: string }).selectedCandidatePairId;
        }
      });
      let type: string | null = null;
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.id === pairId || report.nominated)) {
          const local = stats.get((report as { localCandidateId: string }).localCandidateId);
          if (local) type = (local as { candidateType?: string }).candidateType ?? null;
        }
      });
      return type;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;

    // Only stop remote tracks — the local stream outlives the pairing so the
    // next match connects instantly without re-prompting for the camera.
    for (const track of this.remoteStream.getTracks()) track.stop();

    for (const sender of this.pc.getSenders()) {
      try {
        this.pc.removeTrack(sender);
      } catch {
        /* connection may already be closing */
      }
    }

    this.pc.close();
    this.opts.onStateChange('closed');
  }
}
