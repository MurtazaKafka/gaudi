import { useCallback, useRef, useState, type RefObject } from 'react';

/**
 * State that event handlers can also read synchronously: the ref is updated
 * the moment the setter runs, so two clicks in one frame chain correctly and
 * long-lived listeners never see a stale value.
 */
export function useRefState<T>(initial: T): [T, RefObject<T>, (value: T) => void] {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((value: T) => {
    ref.current = value;
    setState(value);
  }, []);
  return [state, ref, set];
}
