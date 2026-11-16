# Instructions for coding agents

This project builds miniature world tiles in code with threepipe and the *webgi* plugins. A tile is a square of land
(about 40 m) with cut-away sides, built at load time from seeded functions, lit by one sun with screen-space global
illumination (SSGI). Read `README.md` for the layout and the kit table, and `src/tiles/alpine.ts` with
`src/tiles/alpine/` as the worked example, before you write a tile.

## Commands

Use the npm scripts, not ad-hoc `npx` commands.

- `npm run dev`: dev server on http://localhost:5173 (`?tile=<id>&view=<name>&time=<name>`).
- `npm run typecheck`, `npm run build`: run both before you say a change is done.
- `npm run shot -- --tile <id> --views "Diorama,<View>" --off 1`: converged stills, GI on and off, into
  `shots/<id>/`, with the page's console errors. The dev server must be running (or pass `--url <build>`). Run
  `npm run shot:install` once, or set `CHROMIUM_BIN`.

## The tile contract

A tile is a `Tile` (`src/types.ts`) registered in `src/tiles/index.ts`. `setup({viewer, rig})` builds the scene and
returns:

- `views`: named cameras. The first is `Diorama`: the studio backdrop, three-quarter view from above, the whole tile.
  Then 3 to 4 eye-level views with the sky as backdrop, framed like a film still.
- `times`: 1 to 3 times of day (`applyTime` from `kit/stage.ts`).
- `animate(t)` for moving water or machines, `camera(t)` for a camera path (optional).
- `credits`: one line naming every outside asset and its licence, and what is generated.

## How to add a tile

1. Make `src/tiles/<id>.ts` (a thin scene that assembles the parts) and `src/tiles/<id>/` with separate files for
   the landform and paint rule (`terrain.ts`), materials (`materials.ts`), scatter rules (`scatter.ts`) and props
   (`props.ts`). Copy the alpine structure.
2. Register it in `src/tiles/index.ts`.
3. Blockout first: terrain height function, cut faces, the Diorama view and one sun. Render a still and look at it.
4. Then materials, scatter, props, water, the eye-level views, the times of day, in that order, with a still after
   each step.
5. Report per tile: what is procedural, which assets (with licences), the GI effect the tile shows, frame time per
   view, still paths, and what still falls short.

## Conventions

- **Deterministic.** All randomness comes from `rng(seed)` or `new Noise2(seed)` (`kit/noise.ts`), never
  `Math.random`. Give every generator its own seed (trees, rocks, grass, flowers each have one), so a change to one
  does not reshuffle the others.
- **Named features.** Hand-placed things are named constants in the tile's `terrain.ts` (in the example: `PEAK`,
  `TARN`, `HUT`, the `ROAD` and `GORGE` paths). Generators read them: the height function carves the road, scatter
  rules keep trees off the road and out of the camera corridors. To move a feature, change its constant; the land
  and the scatter follow.
- **Kit first.** Use the kit (`buildTerrain`, `buildCutFaces`, `scatterOnTerrain` + `instance`, `TintBatch`,
  `procMaterial`, `stageWorld`, `applyTime`). Do not change what an existing kit function does; add an option or a
  new file in `src/kit/`.
- **Procedural materials** are GLSL hooks on `PhysicalMaterial` (`procMaterial` in `kit/proc.ts`), in world space,
  so merged meshes need no UVs and nothing tiles. Every material must be finite: one NaN spreads through the SSGI
  history as black blocks.
- **Geometry.** Walls and slabs are boxes with thickness, never single planes. Many copies are instanced
  (`instance`), many pieces are merged (`TintBatch`).
- **Assets.** Generate what looks good generated. Outside assets only under CC0 or MIT (Poly Haven through
  `worldAsset(id)` and the `kit/assets.ts` URLs), each named in `credits`. No new npm dependencies without asking.
- **TypeScript**, 4-space indent, no semicolons, single quotes (match the existing files).

## Light that shows GI

- One strong sun and a low sky fill (`fill` 0.05 to 0.15). A higher fill hides the bounce; raise the exposure
  instead.
- Keep a large sunlit surface on screen next to shaded surfaces that receive its light. Screen-space GI sees only
  the screen.
- Covered spaces next to a sunlit floor show the most: an overhang, an arch over snow, a canyon wall over sand.
- Each tile names its GI effect (snow fill, lava glow on rock, red bounce from a barn wall, light through ice) and
  shows it in a GI on/off pair.

## Checking your frames

- After each change: `npm run shot` for the views you touched, with `--off 1` when lighting changed. Open every
  still and look at it; crop to check detail. Compare with the reference before you call it done.
- Headless Chromium renders on the CPU (SwiftShader): use it for composition, errors and GI on/off, with a low
  `--frames` and `--shadow 512` to keep it fast. Its frame times mean nothing.
- Frame time: in a browser tab with a GPU, "Measure frame time" in the panel, or
  `await miniWorld.measureFrameTime()` in the console. It orbits the camera a little and reports the median and p90
  GPU ms per frame at the current canvas size.
- Shader programs: `miniWorld.viewer.renderManager.renderer.info.programs` must have no program whose
  `diagnostics.runnable` is false. The console must show no errors (one SSGI warning on the first frame is
  expected).

## Budgets

- Every view at most 33 ms per frame (30 fps) with GI on, at 2016x1010, on the reference machine (our tiles were
  measured on an Apple M4 Pro; name your machine when you report times). The Alpine Pass measured 24.4 to 30.9 ms
  per view there, in the demo build with the newer SSGI (see README, "Differences from our hosted demo").
- If a view is over: halve the SSGI `rayCount` for that view (views where the ground fills the frame make every ray
  march its full length), turn SSR off where it adds little, lower instance counts far from the camera, use
  `cheapTerrain`.
- Load: the console prints the setup time; report it with the frame times.

## The loop

Render stills, compare with the reference, fix the largest defect, repeat. Finish one tile at high quality before
starting the next. Ask the person before a large polish pass, and say plainly what still falls short.
