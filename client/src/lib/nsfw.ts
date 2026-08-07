/**
 * Client-side NSFW screening of the user's OWN camera.
 *
 * This is a first gate against casual flashers, not an authoritative check:
 * anyone willing to open devtools can disable it. Reports plus server-side
 * bans are the real backstop, and server-side frame sampling is the documented
 * upgrade path. It runs on the local stream only, so no frames ever leave the
 * device unless a report is filed.
 *
 * The model (~4MB) is loaded lazily so it never blocks first paint.
 */

type NsfwModel = {
  classify: (input: HTMLCanvasElement) => Promise<Array<{ className: string; probability: number }>>;
};

let modelPromise: Promise<NsfwModel | null> | null = null;

async function loadModel(): Promise<NsfwModel | null> {
  try {
    // Import via the `core` subpath and name a single model definition.
    // The package's main entry pulls in all three bundled models (~40MB of
    // weights); MobileNetV2 alone is ~3.5MB and accurate enough for a first gate.
    const [{ load }, { MobileNetV2Model }] = await Promise.all([
      import('nsfwjs/core'),
      import('nsfwjs/models/mobilenet_v2'),
    ]);
    const model = await load('MobileNetV2', { modelDefinitions: [MobileNetV2Model] });
    return model as unknown as NsfwModel;
  } catch (err) {
    console.error('[nsfw] model failed to load; screening disabled:', err);
    return null;
  }
}

export function preloadNsfwModel(): void {
  modelPromise ??= loadModel();
}

export interface NsfwMonitorOptions {
  video: HTMLVideoElement;
  /** Sampling cadence. Every couple of seconds is enough to catch exposure. */
  intervalMs?: number;
  /** Combined Porn+Hentai+Sexy probability that counts as a violation. */
  threshold?: number;
  /** Consecutive violating samples required before firing, to damp false positives. */
  strikes?: number;
  onViolation: (score: number) => void;
}

export interface NsfwMonitor {
  stop: () => void;
}

export function startNsfwMonitor(options: NsfwMonitorOptions): NsfwMonitor {
  const { video, intervalMs = 2000, threshold = 0.7, strikes = 2, onViolation } = options;

  const canvas = document.createElement('canvas');
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stopped = false;
  let consecutive = 0;
  let timer: number | undefined;

  modelPromise ??= loadModel();

  void modelPromise.then((model) => {
    if (!model || stopped || !ctx) return;

    const sample = async (): Promise<void> => {
      if (stopped) return;
      if (video.readyState < 2 || video.videoWidth === 0) return;

      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const predictions = await model.classify(canvas);

        const score = predictions
          .filter((p) => p.className === 'Porn' || p.className === 'Hentai' || p.className === 'Sexy')
          .reduce((sum, p) => sum + p.probability, 0);

        if (score >= threshold) {
          consecutive += 1;
          if (consecutive >= strikes) {
            stopped = true;
            onViolation(score);
          }
        } else {
          consecutive = 0;
        }
      } catch (err) {
        console.warn('[nsfw] classification error:', err);
      }
    };

    timer = window.setInterval(() => void sample(), intervalMs);
  });

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) window.clearInterval(timer);
    },
  };
}

/** Grabs a single frame as a JPEG data URL, used as report evidence. */
export function captureFrame(video: HTMLVideoElement, maxWidth = 480): string | undefined {
  if (video.readyState < 2 || video.videoWidth === 0) return undefined;

  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}
