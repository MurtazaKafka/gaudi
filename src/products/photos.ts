/**
 * Product photos for the modelling call: fetched (or dropped) in the browser,
 * downscaled on a canvas and handed over as base64 JPEG. Nothing here ever
 * throws — a photo that cannot be read is simply left out.
 */

export interface Photo {
  mediaType: 'image/jpeg';
  /** base64, no data: prefix */ data: string;
}

const MAX_EDGE = 1000;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/** Downscale any image blob to a JPEG whose long edge is at most `maxEdge`. Null if unreadable. */
export async function photoFromBlob(blob: Blob, maxEdge = MAX_EDGE): Promise<Photo | null> {
  if (!blob.size || blob.size > MAX_SOURCE_BYTES) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff'; // transparent PNGs become white, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    const comma = url.indexOf(',');
    if (!url.startsWith('data:image/jpeg') || comma < 0) return null;
    return { mediaType: 'image/jpeg', data: url.slice(comma + 1) };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/** Fetch one https image (the host must allow cross-origin reads) and downscale it. */
export async function photoFromUrl(url: string, signal?: AbortSignal): Promise<Photo | null> {
  if (!/^https:\/\//i.test(url)) return null;
  const own = new AbortController();
  const timer = window.setTimeout(() => own.abort(), 8000);
  const onAbort = (): void => own.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) return null;
    const r = await fetch(url, { signal: own.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!/^image\//i.test(blob.type)) return null;
    return await photoFromBlob(blob);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The first few photos that could be read, in order. */
export async function photosFromUrls(urls: string[], signal?: AbortSignal, max = 4): Promise<Photo[]> {
  const got = await Promise.all(urls.slice(0, max).map((u) => photoFromUrl(u, signal)));
  return got.filter((p): p is Photo => p !== null);
}

/** The first image among dropped / pasted items, if any. */
export function imageFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const f of Array.from(data.files)) if (/^image\//i.test(f.type)) return f;
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && /^image\//i.test(item.type)) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}
