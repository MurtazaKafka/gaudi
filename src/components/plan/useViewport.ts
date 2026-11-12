import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { usePlanStore } from '../../store';
import { useUiStore } from '../../uiStore';
import { furnitureDef } from '../../catalog';
import { DEFAULT_SCALE, fitView, planBounds, zoomAbout, type Size, type View } from './view';

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

/** A button or link the keyboard is on — Space and Enter belong to it. */
export function isKeyboardFocusedControl(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (!el.closest('button, a[href], summary, [role="button"], [role="menuitem"]')) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

function currentBounds() {
  const { walls, furniture } = usePlanStore.getState();
  return planBounds(
    walls,
    furniture.map((f) => {
      const def = furnitureDef(f.kind);
      return { x: f.x, y: f.y, w: def.w, d: def.d, rotation: f.rotation };
    }),
  );
}

/**
 * The canvas viewport: container size, pan/zoom state, zoom-to-fit, wheel and
 * Space/middle-button panning. Panning is tracked on the window, so it ends
 * wherever the button is released and can never stick.
 */
export function useViewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: DEFAULT_SCALE, tx: 0, ty: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const sizeRef = useRef<Size>({ w: 0, h: 0 });
  const spaceRef = useRef(false);
  const fitPending = useRef(true); // the first measured size fits the loaded plan
  const endPanRef = useRef<(() => void) | null>(null);
  const fitNonce = useUiStore((s) => s.fitNonce);
  const zoomNonce = useUiStore((s) => s.zoomNonce);

  const fit = useCallback(() => {
    const s = sizeRef.current;
    if (s.w <= 0 || s.h <= 0) {
      fitPending.current = true; // hidden (model view): fit when the canvas is back
      return;
    }
    fitPending.current = false;
    setView(fitView(currentBounds(), s));
  }, []);

  // --- container size ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return; // hidden: keep the last real size
      const prev = sizeRef.current;
      if (prev.w !== r.width || prev.h !== r.height) {
        sizeRef.current = { w: r.width, h: r.height };
        setSize(sizeRef.current);
      }
      if (fitPending.current) fit();
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [fit]);

  // --- zoom to fit when a whole plan is swapped in, or when asked to (the command bar) ---
  useEffect(() => {
    fit();
  }, [fitNonce, zoomNonce, fit]);

  // --- wheel: pan, ⌘/pinch zooms. Native + non-passive so it also works over labels and panels. ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 16 : 1;
      const dx = e.deltaX * k;
      const dy = e.deltaY * k;
      if (e.ctrlKey || e.metaKey) {
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        setView((v) => zoomAbout(v, sx, sy, Math.exp(-dy * 0.0022)));
      } else {
        setView((v) => ({ ...v, tx: v.tx - dx, ty: v.ty - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- Space held = pan mode (also in read-only views) ---
  useEffect(() => {
    const setSpace = (on: boolean) => {
      if (spaceRef.current === on) return;
      spaceRef.current = on;
      setSpaceDown(on);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (useUiStore.getState().mode !== 'plan') return;
      if (isTypingTarget(e.target) || isKeyboardFocusedControl(e.target)) return;
      e.preventDefault(); // no page scroll, no re-click of the last button pressed
      setSpace(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      // A button clicked earlier still has focus; releasing Space must not press it again.
      if (spaceRef.current) e.preventDefault();
      setSpace(false);
    };
    const release = () => {
      setSpace(false);
      endPanRef.current?.();
    };
    const onVisibility = () => {
      if (document.hidden) release();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    const unsub = useUiStore.subscribe((s, prev) => {
      if (s.mode !== prev.mode && s.mode !== 'plan') release();
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
      endPanRef.current?.();
    };
  }, []);

  /**
   * Capture-phase mousedown on the container: middle button or Space+drag
   * starts a pan before any tool (or the canvas library) sees the press.
   */
  const onMouseDownCapture = useCallback((e: ReactMouseEvent) => {
    if (!(e.button === 1 || (e.button === 0 && spaceRef.current))) return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    endPanRef.current?.();

    let last = { x: e.clientX, y: e.clientY };
    const onMove = (ev: MouseEvent) => {
      if (ev.buttons === 0) {
        end(); // the release happened somewhere we never heard about
        return;
      }
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    };
    const end = (ev?: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', end, true);
      endPanRef.current = null;
      setPanning(false);
      if (ev) {
        // The press never reached the canvas or the labels; neither should the
        // release, or the click the browser makes out of the pair.
        ev.stopPropagation();
        const swallow = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener('click', swallow, true);
        window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', end, true);
    endPanRef.current = () => end();
    setPanning(true);
  }, []);

  return { containerRef, size, view, spaceDown, panning, fit, onMouseDownCapture };
}
