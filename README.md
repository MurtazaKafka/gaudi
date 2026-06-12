# Gaudí

Draw a floor plan, hit **Build**, walk around the house. Named for Antoni Gaudí.

A 2D drafting canvas (react-konva) feeding a 3D extruded model (react-three-fiber).
One Zustand store holds the plan — walls, rooms, openings, settings — as the single
source of truth; the 3D scene is always regenerated from it, never edited directly.

## Run

```sh
npm install
npm run dev
```

## Use

| Action | How |
| --- | --- |
| Draw walls | `W`, click point to point; `Enter`/`Esc`/right-click ends the run |
| Select / adjust | `V`, click a wall; drag endpoints; `⌫` deletes |
| Doors / windows | `D` / `N`, hover a wall, click to place; select one to edit width |
| Name a room | select tool, double-click the room label |
| Place furniture | `F` opens the palette, click an item, click to place, `R` rotates |
| Furnish with AI | select tool, click a room, "Furnish with AI" |
| Build the model | the Build button (or the Plan / Model toggle) |
| Navigate 3D | drag orbits · scroll zooms · shift-drag pans · `Esc` back to plan |
| Pan / zoom 2D | scroll pans · `⌘`-scroll or pinch zooms · space-drag pans |

Walls snap to a 0.5 m grid and to existing endpoints, so loops close cleanly.
Closed loops auto-detect as rooms (T-junctions count). Doors and windows split
the wall into pieces — side segments, lintel, sill — no boolean geometry anywhere.

The plan persists to localStorage. The tray icons in the top bar import/export
the plan as JSON and export the model as `.glb`.

## AI furnishing

Click a room with the select tool and hit **Furnish with AI**: Claude
(`claude-opus-4-8`, called directly from the browser with your own Anthropic
API key — stored only in localStorage) sees the room's polygon, name, doors,
windows, and existing furniture, and proposes a layout from the parametric
catalog as structured JSON. Suggestions appear as ghosts; geometry validation
drops anything outside the room or overlapping before you accept.

## Deploy

Static Vite build, no backend:

```sh
npm run build        # outputs dist/
vercel               # or any static host
```

## Still out of scope

Natural-language plan editing, style transfer, multi-floor and stairs, curved
walls, accounts. Later-phase candidates.
