import { FURNITURE, FURNITURE_KINDS, type FurnitureKind } from '../catalog';
import { useUiStore } from '../uiStore';

const groups: { title: string; kinds: FurnitureKind[] }[] = [
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

export function FurniturePalette() {
  const placingKind = useUiStore((s) => s.placingKind);
  const tool = useUiStore((s) => s.tool);
  const startPlacing = useUiStore((s) => s.startPlacing);

  return (
    <aside className="palette">
      <div className="palette-head">Furniture</div>
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
                <span className="palette-item-dims">
                  {def.w.toFixed(1)}×{def.d.toFixed(1)}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
