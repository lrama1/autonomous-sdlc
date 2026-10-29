import { useCallback, useEffect, useState } from 'react';
import type { ReadyPreviewDto } from '@sdlc/schemas';
import { getReadyPreviews, markPreviewSeen } from './api';

const CHANGED = 'sdlc:previews-changed';
const ALERTED = 'sdlc.preview.alerted';

/** Tells every part of the page that the list of ready previews changed, so each looks again at once. */
export const previewsChanged = () => window.dispatchEvent(new Event(CHANGED));

/** Opening or dismissing a preview's notice: it leaves the queue, for good. */
export async function clearReadyPreview(id: string): Promise<void> {
  await markPreviewSeen(id).catch(() => {});
  previewsChanged();
}

/** The banner for a preview is hidden once the person closes it, though its notice stays in the queue until opened. */
const alertedIds = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALERTED) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
export const hideBanner = (id: string) => {
  const s = alertedIds();
  s.add(id);
  // Only the latest are worth remembering; a preview lives for half an hour.
  localStorage.setItem(ALERTED, JSON.stringify([...s].slice(-50)));
  previewsChanged();
};
export const bannerHidden = (id: string) => alertedIds().has(id);

/** The previews this person started that are ready to open, kept fresh. */
export function useReadyPreviews(signedIn: boolean, everyMs = 5000): ReadyPreviewDto[] {
  const [items, setItems] = useState<ReadyPreviewDto[]>([]);
  const load = useCallback(
    () =>
      getReadyPreviews().then(
        (r) => setItems(r),
        () => {}, // a failed look keeps the last answer
      ),
    [],
  );
  useEffect(() => {
    if (!signedIn) return setItems([]);
    void load();
    const poll = setInterval(() => void load(), everyMs);
    const again = () => void load();
    window.addEventListener('focus', again);
    window.addEventListener(CHANGED, again);
    return () => {
      clearInterval(poll);
      window.removeEventListener('focus', again);
      window.removeEventListener(CHANGED, again);
    };
  }, [signedIn, everyMs, load]);
  return items;
}
