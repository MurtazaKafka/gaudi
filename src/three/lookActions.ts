/** The two plan edits the model view can make: style and roof. Each pick is exactly one undo step. */
import { transact } from '../history';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import type { RoofKind } from '../types';
import { styleById } from './styles';
import { useViewStore } from './viewStore';

/** Pick a roof; the view follows so the change is visible straight away. */
export function chooseRoof(roof: RoofKind): void {
  if (useUiStore.getState().readOnly) return;
  if (usePlanStore.getState().look?.roof !== roof) transact(() => usePlanStore.getState().setLook({ roof }));
  const view = useViewStore.getState();
  if (roof === 'none' && view.view === 'exterior') view.setView('dollhouse');
  else if (roof !== 'none' && view.view === 'dollhouse') view.setView('exterior');
}

export function chooseStyle(id: string): void {
  if (useUiStore.getState().readOnly) return;
  const next = styleById(id).id;
  if (usePlanStore.getState().look?.style !== next) transact(() => usePlanStore.getState().setLook({ style: next }));
}
