'use client';

import { useEffect, useRef } from 'react';
import { saveProgressAction } from '@/lib/actions/progress';

const PROGRESS_SAVE_INTERVAL_MS = 15000;

export function VideoPlayer({
  videoId,
  src,
  initialPositionSeconds,
}: {
  videoId: string;
  /**
   * Signed, short-lived playback URL. Always null in this slice — no upload, storage, or signed-
   * playback endpoint exists yet (later slice). This component is built against that future prop
   * now so wiring it up later doesn't require rewriting the player.
   */
  src: string | null;
  initialPositionSeconds: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !src) return;

    if (initialPositionSeconds > 0) {
      el.currentTime = initialPositionSeconds;
    }

    let lastSaved = 0;
    const save = () => {
      const position = Math.floor(el.currentTime);
      if (position === lastSaved) return;
      lastSaved = position;
      void saveProgressAction({
        videoId,
        positionSeconds: position,
        durationSeconds: Number.isFinite(el.duration) ? Math.floor(el.duration) : null,
      });
    };

    const interval = setInterval(() => {
      if (!el.paused) save();
    }, PROGRESS_SAVE_INTERVAL_MS);

    el.addEventListener('pause', save);
    el.addEventListener('ended', save);

    return () => {
      clearInterval(interval);
      el.removeEventListener('pause', save);
      el.removeEventListener('ended', save);
    };
  }, [src, videoId, initialPositionSeconds]);

  if (!src) {
    return (
      <div className="player-placeholder" role="status">
        <p>Este video aún no está disponible para reproducción.</p>
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- captions belong to individual videos, added at upload time (later slice)
    <video ref={videoRef} className="player" src={src} controls playsInline preload="metadata" />
  );
}
