/** Ask Claude for one layout, check it, and give it one chance to fix what the checks found. */
import { askJson, isAbort } from '../ai/client';
import { buildPrompt, checkLayout, LAYOUT_SCHEMA, LAYOUT_TAG, SYSTEM_PROMPT, type Checked, type Idea } from './aiPrompt';
import type { Brief } from './brief';
import type { Layout } from './layout';
import type { Outline } from './outline';

export interface AskLayoutOptions {
  signal?: AbortSignal;
  /** Vary this layout rather than starting fresh. */
  base?: Layout;
  /** Fill this outline (the person drew it): rooms outside it, or gaps inside it, are sent back once to be fixed. */
  outline?: Outline;
}

export interface AskedLayout {
  layout: Layout;
  /** Ways it still misses the brief (shown on the scorecard, not fatal). */
  problems: string[];
}

export async function askLayout(brief: Brief, idea: Idea, opts: AskLayoutOptions = {}): Promise<AskedLayout> {
  const ask = (prompt: string, effort: 'medium' | 'high') =>
    askJson<unknown>({
      tag: LAYOUT_TAG,
      system: SYSTEM_PROMPT,
      prompt,
      schema: LAYOUT_SCHEMA,
      effort,
      signal: opts.signal,
    });

  const { outline } = opts;
  const first = checkLayout(await ask(buildPrompt(brief, idea, { base: opts.base, outline }), 'medium'), brief, outline);
  if (first.fatal.length === 0 && first.major.length === 0) return { layout: first.layout, problems: [] };

  let second: Checked | null = null;
  try {
    second = checkLayout(
      await ask(
        buildPrompt(brief, idea, {
          base: opts.base,
          outline,
          feedback: { previous: first.layout, problems: [...first.fatal, ...first.major] },
        }),
        'high',
      ),
      brief,
      outline,
    );
  } catch (e) {
    // A failed retry only matters if the first try was unusable.
    if (isAbort(e) || first.fatal.length > 0) throw e;
  }
  if (second && second.fatal.length === 0 && (first.fatal.length > 0 || second.major.length <= first.major.length)) {
    return { layout: second.layout, problems: second.major };
  }
  if (first.fatal.length === 0) return { layout: first.layout, problems: first.major };
  throw new Error('The rooms didn’t fit together.');
}
