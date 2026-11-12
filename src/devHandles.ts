/**
 * Dev-only: expose the app's own module instances on `window.__gaudi` so tests
 * and browser automation can drive them. (Dynamic `import('/src/x.ts')` from
 * the console can yield a second module instance under Vite HMR — always go
 * through this handle instead.)
 */
import * as history from './history';
import * as plan from './plan';
import * as preview from './preview';
import * as toast from './toast';
import * as units from './units';
import * as client from './ai/client';
import { usePlanStore } from './store';
import { useUiStore } from './uiStore';

const handles = { history, plan, preview, toast, units, ai: client, planStore: usePlanStore, uiStore: useUiStore };

declare global {
  interface Window {
    __gaudi?: typeof handles & Record<string, unknown>;
  }
}

window.__gaudi = { ...(window.__gaudi ?? {}), ...handles };
