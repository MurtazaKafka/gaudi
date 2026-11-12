import { Component, lazy, Suspense, useMemo, useRef, type ReactNode } from 'react';
import { FURNITURE, FURNITURE_KINDS, type BuiltinKind } from '../catalog';
import { DetailsForm } from '../products/DetailsForm';
import { useImportStore } from '../products/importProduct';
import { YourItems } from '../products/YourItems';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { formatFootprint, useUnits } from '../units';
import '../styles/products.css';

// three.js only loads once the plan has an item of its own to show.
const TurntableCanvas = lazy(() => import('../products/Turntables'));

const groups: { title: string; kinds: BuiltinKind[] }[] = [
  { title: 'Bedroom', kinds: ['bed_double', 'bed_single', 'nightstand', 'wardrobe'] },
  { title: 'Living', kinds: ['sofa', 'armchair', 'coffee_table', 'tv_stand', 'bookshelf', 'rug', 'plant'] },
  { title: 'Dining & work', kinds: ['dining_table', 'chair', 'desk'] },
  { title: 'Kitchen', kinds: ['counter', 'kitchen_sink', 'stove', 'fridge'] },
  { title: 'Bath', kinds: ['toilet', 'bathroom_sink', 'bathtub'] },
  { title: 'Event', kinds: ['stage', 'event_table', 'speaker', 'mic', 'trash_bin'] },
];

// Safety net: anything new in the catalog shows up unguarded at the bottom.
const grouped = new Set(groups.flatMap((g) => g.kinds));
const rest = FURNITURE_KINDS.filter((k) => !grouped.has(k));

/** The turntables are a nicety: if WebGL is not to be had, the rows simply go without. */
class Optional extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function FurniturePalette() {
  const placingKind = useUiStore((s) => s.placingKind);
  const tool = useUiStore((s) => s.tool);
  const startPlacing = useUiStore((s) => s.startPlacing);
  const customItems = usePlanStore((s) => s.customItems);
  const draft = useImportStore((s) => s.draft);
  const units = useUnits();
  const root = useRef<HTMLElement>(null);

  const items = useMemo(() => Object.values(customItems).sort((a, b) => b.createdAt - a.createdAt), [customItems]);
  const models = useMemo(() => items.map((item) => ({ id: item.id, def: item })), [items]);

  return (
    <aside className="palette" ref={root}>
      <div className="palette-scroll">
        <div className="palette-head">Furniture</div>
        {draft && <DetailsForm key={draft.seq} draft={draft} units={units} />}
        <YourItems items={items} units={units} />
        {[...groups, ...(rest.length ? [{ title: 'Other', kinds: rest }] : [])].map((g) => (
          <div key={g.title} className="palette-group">
            <div className="palette-group-title">{g.title}</div>
            {g.kinds.map((kind) => {
              const def = FURNITURE[kind];
              const active = tool === 'furniture' && placingKind === kind;
              return (
                <button
                  key={kind}
                  className={`palette-item ${active ? 'active' : ''}`}
                  onClick={() => startPlacing(kind)}
                >
                  <span className="palette-item-label">{def.label}</span>
                  <span className="palette-item-dims">{formatFootprint(def.w, def.d, units)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {models.length > 0 && (
        <Optional>
          <Suspense fallback={null}>
            <TurntableCanvas container={root} items={models} />
          </Suspense>
        </Optional>
      )}
    </aside>
  );
}
