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
| Build the model | the Build button (or the Plan / Model toggle) |
| Navigate 3D | drag orbits · scroll zooms · shift-drag pans · `Esc` back to plan |
| Pan / zoom 2D | scroll pans · `⌘`-scroll or pinch zooms · space-drag pans |

Walls snap to a 0.5 m grid and to existing endpoints, so loops close cleanly.
Closed loops auto-detect as rooms (T-junctions count). Doors and windows split
the wall into pieces — side segments, lintel, sill — no boolean geometry anywhere.

The plan persists to localStorage. The tray icons in the top bar import/export
the plan as JSON and export the model as `.glb`.

## Deploy

Static Vite build, no backend:

```sh
npm run build        # outputs dist/
vercel               # or any static host
```

## Out of scope for v1

AI features (natural-language editing, furniture suggestions), multi-floor and
stairs, curved walls, furniture, accounts. Phase 2 candidates.
