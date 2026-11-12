/** What kind of document is on the canvas right now. */
import { usePreviewStore } from './preview';
import { useShareStore } from './share/shareStore';

/**
 * True while the store holds something other than the user's own working
 * plan: a shared link being viewed, a proposal or generated option being
 * previewed. Autosave / project sync must not run then.
 */
export function planIsEphemeral(): boolean {
  const share = useShareStore.getState();
  return usePreviewStore.getState().active || !!share.viewId || !!share.previewPid;
}
