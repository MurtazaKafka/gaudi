# Gaudí

Draw a floor plan — or generate one from a brief — hit **Build**, walk around the
house. Named for Antoni Gaudí.

A 2D drafting canvas (react-konva) feeding a 3D extruded model (react-three-fiber).
One Zustand store holds the plan — walls, rooms, openings, settings — as the single
source of truth; the 3D scene is always regenerated from it, never edited directly.

## Demo

**<https://gaudi-tau.vercel.app/#/demo>** plays a one-minute tour: Gaudí draws
a house, furnishes it, builds it, changes its look, takes it to dusk and
renders it, with a caption for each step. It is the real app driving itself
(`src/demo/tour.ts`), not a video — so it needs no API key, costs nothing, and
never touches the visitor's own plan (it plays on a preview). `Esc` leaves at
any point; the closing card offers to keep the house as a new project.

Also reachable from the start sheet ("Watch the one-minute demo") and from
`⌘K` → "Play the demo".

## Run

```sh
npm install
npm run dev                  # the app, http://localhost:5173
node scripts/share-dev.mjs   # the API (sharing, product links), http://localhost:5177
```

The app works without the API; sharing and reading product links need it.

## Use

| Action | How |
| --- | --- |
| Draw walls | `W`, click point to point; `Enter`/`Esc`/right-click ends the run |
| Select / adjust | `V`, click a wall; drag endpoints; `⌫` deletes |
| Draw precisely | while drawing, type a length and `Enter`; hold `⇧` to lock the angle to 15° |
| Move / resize a wall | drag a selected wall across itself; click its length tag to type a new length |
| Measure / dimensions | `M`, click two points (`Esc` clears) · `L` shows every wall's length · `0` zooms to fit |
| Move things | drag a selected door, window or furniture; arrows nudge (`⇧` = fine); `⌘D` duplicates furniture |
| Doors / windows | `D` / `N`, hover a wall, click to place; select one to edit width |
| Name a room | select tool, double-click the room label |
| Place furniture | `F` opens the palette, click an item, click to place, `R` rotates |
| Add an Amazon product | the search field in the top bar (`A` jumps to it): type a few words ("grey sectional sofa") and **Add** a result, or paste a product link. It is modelled in 3D at the listing's real size, then the next click on the plan places it like any furniture. Your items stay in the furniture palette (`F`) |
| Furnish with AI | select tool, click a room, "Furnish with AI" |
| Ask Gaudí | `⌘K`, then a command or a plain request about the selection ("make this 1 m wider") |
| Generate layouts | `G`: set rooms, size and shape, Generate; click a card to try it on the canvas, the banner keeps it |
| Fill your own outline | draw one closed loop of walls (any square-cornered shape), `G`: it shows as "Your outline" and the rooms are fitted inside it. **Draw outline** puts a preset shape on the canvas to drag into proportion first |
| Keep the part you like | `G` on a plan with rooms: tick rooms under **Keep**, then "Regenerate the rest" |
| Build the model | the Build button (or the Plan / Model toggle) |
| Navigate 3D | drag orbits · scroll zooms · shift-drag pans · `Esc` back to plan |
| Dress the model | the bar under the model: view (`1` dollhouse · `2` exterior · `3` walk), style, roof, time of day, `S` saves a picture |
| Walk through | `3`, click the floor, `W` `A` `S` `D` and the mouse; `Esc` steps back out |
| Render | in the 3D view, **Render** (or `R`): the view is path-traced with real light bounces and soft shadows, pick Screen / 2K / 4K, then **Save image**. **Shot** sets the camera: Aerial, Street, Corner, Top |
| Pan / zoom 2D | scroll pans · `⌘`-scroll or pinch zooms · space-drag pans |
| Undo / redo | `⌘Z` / `⇧⌘Z` — everything is undoable, including AI edits and generated plans |
| Plan look | `C` switches Color (room fills, solid walls, furnished) and Paper (line drawing) |
| Units, wall size, API key | the gear: meters or feet, wall height and thickness, your Anthropic key |
| Export | **Export**: PDF plan sheet with room schedule, PNG, SVG, DXF, IFC, GLB, room CSV, plan JSON |
| Every shortcut | `?` |

Walls snap to a 0.5 m grid and to existing endpoints, so loops close cleanly.
Closed loops auto-detect as rooms (T-junctions count). Doors and windows split
the wall into pieces — side segments, lintel, sill — no boolean geometry anywhere.

The plan persists to localStorage and is kept in your project library.

## AI

Every AI feature calls Claude directly from the browser with your own
Anthropic API key (asked for the first time you use one, stored only in this
browser's localStorage). The model id lives in one place, `src/ai/client.ts`.
Replies are structured JSON, validated geometrically before anything touches
the plan, and land as a single undo step.

- **Furnish** — click a room → Furnish: suggestions appear as ghosts to accept,
  retry or discard. "Furnish all rooms" (`⌘K`) does the whole house.
- **Ask** (`⌘K`) — plain requests about the plan or the selection ("make the
  kitchen 1 m wider", "add a window to the bedroom"). Claude answers with
  operations (move a wall, add an opening, place furniture…), not a new plan.
- **Generate** (`G`) — with a key, Claude drafts the layouts; without one, a
  built-in drafter does, so generation always works.
- **Products** — search or paste a link; Claude builds the item from primitive
  solids at the listing's real dimensions, using its photos when available.

### Product links

`/api/product` reads one product page per pasted link, identifying itself
honestly (`GaudiLinkPreview/1.0`) — it never impersonates a browser, never
retries around a block and never fetches search pages. When a retailer
declines, Gaudí looks the product up through Claude's hosted web search, and
"paste the details or drop a photo" always works. Search uses the same hosted
web search. The endpoint only fetches public https hosts.

## The 3D model

Every style except the maquette is built from real assets, all CC0 and all in
`public/` (about 9 MB, loaded only when the 3D view opens):

- **Materials** — photographed PBR textures from Poly Haven (wood, tile,
  carpet, plaster, brick, timber, roofing) in `public/textures`, tinted to
  each style's palette. The list is in `src/three/surfaces.ts`.
- **Furniture** — low-poly models from the Kenney Furniture Kit in
  `public/models`, stretched to each catalog item's footprint and recoloured
  from the style (`src/three/furnitureModels.ts`). Product items from links
  keep their own Claude-built models.
- **Light** — two HDR skies from Poly Haven in `public/sky` light the model;
  the sun follows the time-of-day slider, and from 18:00 the rooms light up
  from inside. The sky you *see* is drawn (a three-colour gradient that
  shifts with the hour, `src/three/sky.ts`), so it is calm in every direction.
- **Lawn** — no photograph: soft ground with slow drifts of tone out to the
  horizon, and around the house tufts of real blades in one instanced mesh
  that keep clear of rooms, walls, path and doorstep and thin out with
  distance (`src/three/garden.ts`). Scene dressing, never in the plan.

### How the live view becomes a picture

Ideas borrowed from Tiny Glade, kept to what a browser's WebGL2 does cheaply
(`src/three/LivePost.tsx`). The view draws on demand, so none of this costs
anything while the model is still:

- **Shading where surfaces meet** (three.js's GTAO pass) — walls, furniture
  and ground sit together instead of floating.
- **Soft focus** — whatever the camera turns around stays sharp; the far lawn
  and anything right in front of the lens soften, the scale-model look. Off
  while walking.
- **Colour** — styled looks use a neutral film curve, so a wall is the colour
  its style chose; the maquette keeps the filmic curve that bleaches it to
  paper white.
- **It builds itself** — walls rise in a sweep when the model opens, furniture
  settles, the roof comes down (`src/three/rise.ts`); skipped when the system
  asks for reduced motion.
- **Zoom goes where you point**, and Snapshot saves exactly what is on screen.

In the plan, clicking a door or window again with its own tool steps it to the
next size: a door becomes a wide door, then a pair of leaves; a window gains
lights. Plan and model draw the result the same way.

**Shot** in the bar under the model jumps the camera to Aerial, Street (eye
level at the entrance), Corner or Top.

## Renders

**Render** (or `R`) runs entirely in the browser: a GPU path tracer
(`three-gpu-pathtracer`) re-lights the model sample by sample, shown through a
denoiser. Free, no keys. Pick Screen, 2K or 4K in the render bar; **Save
image** writes the picture at that size.

## Sharing

**Share** (top bar) publishes the current plan at `#/p/{id}` — a link anyone
can open. Viewers get a read-only canvas with comments, plus **Propose
changes**: they edit a scratch copy (their own plan and yours stay untouched)
and submit it as a draft. You review drafts in the Share panel — preview on
the canvas, then accept (it becomes the live plan, like merging a PR) or
dismiss. Accepting and publishing require the owner key, which never leaves
your browser; the server stores only its hash.

Every project has its own link, in three strengths: the plain link (view,
comment, propose), `…/view` (just the plan) and an edit link the owner can copy
or reset (`…/edit/{secret}`; its holder publishes directly). A proposal can
also be sent back with a note — **Changes** — which its author sees on the
link and can revise. Any visitor can **Remix into my projects**: the plan is
copied into their own library and the card remembers where it came from.

## Projects

`P` (or the folder beside the plan name) opens Projects: every plan you draw
is kept there automatically, newest first — open, duplicate, rename, delete
(with Undo), **New plan**, and a row of starter templates. Projects live in
this browser's localStorage; nothing is saved while you are looking at someone
else's link or previewing an option.

Backend: Vercel serverless functions + Blob storage, append-only revisions.
Local dev: `node scripts/share-dev.mjs` runs the same API against a local
directory on :5177.

## Deploy

Live at https://gaudi-tau.vercel.app. The Vercel project is connected to this
GitHub repo: every push to `main` deploys to production, and every other
branch or pull request gets its own preview URL. No manual step.

To deploy by hand anyway: `vercel --prod`. Locally, `npm run build` outputs `dist/`.

The functions need `BLOB_READ_WRITE_TOKEN` (Vercel Blob) for sharing; it is set
in the project. As a purely static site everything except sharing and
product-link reading works.

## Still out of scope

Multiple storeys and stairs, curved walls, room layouts inside angled outlines
(generation works on square-cornered footprints), photoreal image renders,
accounts. Plans are concept designs, not construction documents.
