'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const ACCEPTED_MIME = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'];
const MAX_PART_RETRIES = 3;

type Phase = 'idle' | 'needs-file-for-resume' | 'uploading' | 'completing' | 'done' | 'error' | 'aborted';

type PartRecord = { partNumber: number; etag: string };

type PersistedSession = {
  uploadSessionId: string;
  partSize: number;
  totalParts: number;
  fileName: string;
  fileSize: number;
};

function storageKey(videoId: string) {
  return `video-upload-session:${videoId}`;
}

function loadPersistedSession(videoId: string): PersistedSession | null {
  try {
    const raw = window.localStorage.getItem(storageKey(videoId));
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}

function savePersistedSession(videoId: string, session: PersistedSession) {
  try {
    window.localStorage.setItem(storageKey(videoId), JSON.stringify(session));
  } catch {
    // Non-fatal: losing this just means a page reload mid-upload can't offer resume; the upload
    // in progress this tab session is unaffected.
  }
}

function clearPersistedSession(videoId: string) {
  try {
    window.localStorage.removeItem(storageKey(videoId));
  } catch {
    // ignore
  }
}

export function VideoUpload({ videoId, initialStatus }: { videoId: string; initialStatus: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0); // parts completed
  const [totalParts, setTotalParts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<PersistedSession | null>(null);
  const abortRequested = useRef(false);

  useEffect(() => {
    if (initialStatus === 'uploading') {
      const persisted = loadPersistedSession(videoId);
      if (persisted) {
        setPendingResume(persisted);
        setPhase('needs-file-for-resume');
      }
    }
  }, [videoId, initialStatus]);

  const resetState = useCallback(() => {
    setPhase('idle');
    setProgress(0);
    setTotalParts(0);
    setError(null);
    abortRequested.current = false;
  }, []);

  async function uploadPart(sessionId: string, file: File, partNumber: number, partSize: number): Promise<PartRecord> {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const blob = file.slice(start, end);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
      try {
        const signRes = await fetch(`/api/admin/uploads/${sessionId}/sign-part`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partNumber }),
        });
        if (!signRes.ok) throw new Error('sign_failed');
        const { url } = (await signRes.json()) as { url: string };

        const putRes = await fetch(url, { method: 'PUT', body: blob });
        if (!putRes.ok) throw new Error('put_failed');
        const etag = putRes.headers.get('ETag');
        if (!etag) throw new Error('missing_etag');

        return { partNumber, etag };
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('part_upload_failed');
  }

  async function runUpload(sessionId: string, partSize: number, totalPartsCount: number, file: File, alreadyUploaded: Map<number, string>) {
    setTotalParts(totalPartsCount);
    setProgress(alreadyUploaded.size);
    setPhase('uploading');

    const parts: PartRecord[] = Array.from(alreadyUploaded, ([partNumber, etag]) => ({ partNumber, etag }));

    try {
      for (let partNumber = 1; partNumber <= totalPartsCount; partNumber++) {
        if (abortRequested.current) {
          setPhase('aborted');
          clearPersistedSession(videoId);
          return;
        }
        if (alreadyUploaded.has(partNumber)) continue; // already on R2 from a previous attempt
        const part = await uploadPart(sessionId, file, partNumber, partSize);
        parts.push(part);
        setProgress((p) => p + 1);
      }

      setPhase('completing');
      const completeRes = await fetch(`/api/admin/uploads/${sessionId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })) }),
      });
      if (!completeRes.ok) {
        const body = await completeRes.json().catch(() => ({}));
        throw new Error(body.error ?? 'complete_failed');
      }

      clearPersistedSession(videoId);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error');
      setPhase('error');
      // Deliberately keep the persisted session: the admin can retry and this component will
      // re-fetch R2's authoritative part list rather than re-uploading everything from scratch.
    }
  }

  async function startUpload(file: File) {
    resetState();
    setError(null);

    try {
      const initRes = await fetch('/api/admin/uploads/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, filename: file.name, mimeType: file.type, sizeBytes: file.size }),
      });
      if (!initRes.ok) {
        const body = await initRes.json().catch(() => ({}));
        throw new Error(body.error ?? 'init_failed');
      }
      const init = (await initRes.json()) as { uploadSessionId: string; partSize: number; totalParts: number };

      savePersistedSession(videoId, {
        uploadSessionId: init.uploadSessionId,
        partSize: init.partSize,
        totalParts: init.totalParts,
        fileName: file.name,
        fileSize: file.size,
      });

      await runUpload(init.uploadSessionId, init.partSize, init.totalParts, file, new Map());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error');
      setPhase('error');
    }
  }

  /**
   * Resume after a page reload. The browser cannot persist the original File object across a
   * reload (a deliberate browser security restriction), so the admin must re-select the file from
   * disk. Name + size are checked as a best-effort sanity check only — this does NOT cryptographically
   * guarantee the re-selected file is byte-identical to the original; a mismatched-content re-select
   * with the same name/size would not be caught here (the worker's SHA-256 verification later would
   * still catch corruption, but not a wrong-but-same-size file).
   */
  async function resumeWithFile(file: File) {
    if (!pendingResume) return;
    if (file.name !== pendingResume.fileName || file.size !== pendingResume.fileSize) {
      setError('selected_file_does_not_match');
      setPhase('error');
      return;
    }

    setError(null);
    try {
      const partsRes = await fetch(`/api/admin/uploads/${pendingResume.uploadSessionId}/parts`);
      if (!partsRes.ok) throw new Error('list_parts_failed');
      const { parts } = (await partsRes.json()) as { parts: { partNumber: number; etag: string }[] };
      const alreadyUploaded = new Map(parts.map((p) => [p.partNumber, p.etag]));

      await runUpload(pendingResume.uploadSessionId, pendingResume.partSize, pendingResume.totalParts, file, alreadyUploaded);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error');
      setPhase('error');
    }
  }

  async function handleAbort() {
    abortRequested.current = true;
    const persisted = pendingResume ?? loadPersistedSession(videoId);
    if (persisted) {
      await fetch(`/api/admin/uploads/${persisted.uploadSessionId}/abort`, { method: 'POST' }).catch(() => {});
    }
    clearPersistedSession(videoId);
    setPhase('aborted');
  }

  if (initialStatus === 'available') {
    return <p className="empty-state">El archivo principal ya está disponible. Elimínalo primero para volver a subir uno nuevo.</p>;
  }

  if (phase === 'needs-file-for-resume' && pendingResume) {
    return (
      <div>
        <p>
          Hay una subida sin terminar (&ldquo;{pendingResume.fileName}&rdquo;). Selecciona el mismo archivo para
          continuar donde se quedó.
        </p>
        <label>
          Selecciona el archivo original
          <input
            type="file"
            accept={ACCEPTED_MIME.join(',')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void resumeWithFile(file);
            }}
          />
        </label>
        <button type="button" className="button--secondary" onClick={handleAbort}>
          Cancelar esta subida
        </button>
      </div>
    );
  }

  return (
    <div>
      {(phase === 'idle' || phase === 'aborted' || phase === 'error') && (
        <label>
          Archivo de video (MP4, MOV, MKV o WebM)
          <input
            type="file"
            accept={ACCEPTED_MIME.join(',')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void startUpload(file);
            }}
          />
        </label>
      )}

      {(phase === 'uploading' || phase === 'completing') && (
        <div>
          <progress value={progress} max={totalParts || 1} />
          <p>{phase === 'completing' ? 'Finalizando…' : `Subiendo parte ${progress} de ${totalParts || '…'}`}</p>
          <button type="button" className="button--danger" onClick={handleAbort}>
            Cancelar subida
          </button>
        </div>
      )}

      {phase === 'done' && <p>Subida completada. El respaldo se procesará en segundo plano.</p>}
      {phase === 'aborted' && <p role="alert">Subida cancelada.</p>}
      {phase === 'error' && <p role="alert">Error al subir el video ({error}). Puedes intentarlo de nuevo.</p>}
    </div>
  );
}
