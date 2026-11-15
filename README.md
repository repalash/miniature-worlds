# Miniature worlds starter

[![Live demo](https://img.shields.io/badge/live%20demo-Alpine%20Pass-e3ad62)](https://files.threepipe.org/p/miniature-worlds/starter/)
[![threepipe 0.6](https://img.shields.io/badge/threepipe-0.6.0-1382fb)](https://threepipe.org)
[![@threepipe/webgi-plugins 0.7](https://img.shields.io/badge/%40threepipe%2Fwebgi--plugins-0.7.0-1382fb)](https://www.npmjs.com/package/@threepipe/webgi-plugins)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-555)](LICENSE)

[![The Alpine Pass, the starter's example tile: a gravel road crosses a gorge on a granite arch and climbs to a saddle under a snow peak](https://files.threepipe.org/p/miniature-worlds/starter/readme/hero.jpg)](https://files.threepipe.org/p/miniature-worlds/starter/)

Build miniature world tiles in code: a square of land with cut-away sides, lit in real time in the browser. The
starter runs on [threepipe](https://threepipe.org) and the free [*webgi* plugins](https://webgi.dev) (SSGI, SSR,
TAA, bloom, depth of field). It has the world kit we used for our tiles and one finished tile, the Alpine Pass
(above).

- **Live demo** of this starter's build: https://files.threepipe.org/p/miniature-worlds/starter/
- **All our tiles**, each with a still and a live link: https://files.threepipe.org/p/miniature-worlds/
- **The guide**: `GUIDE.md`, also on threepipe.org as
  [Build miniature worlds with a coding agent](https://threepipe.org/notes/miniature-worlds.html)

It is made to be driven by a coding agent (Claude Code, Codex, or any other). `AGENTS.md` (and `CLAUDE.md`) tells
the agent the rules, the tile contract, how to check its frames and the budgets.

[![Miniature world tiles on a dark backdrop; play the 17 s video](https://files.threepipe.org/p/miniature-worlds/starter/readme/video.jpg)](https://files.threepipe.org/a/9e2c89be/miniature-worlds.mp4)

## What you get

**The world kit and a finished tile.** Terrain from a height function with erosion and cut-away rock beds, seeded
scatter, water, props and procedural materials, all generated when the page loads. Close-ups of the Alpine Pass:

![Four close-ups of the Alpine Pass: the cut-away side with folded rock beds, spruces and grass scattered on the slope, the tarn and its waterfall, the arch bridge with rails and a signpost](https://files.threepipe.org/p/miniature-worlds/starter/readme/kit.jpg)

**Light that shows GI.** Each tile is staged for one global illumination effect and proves it with a GI on/off
pair. Under the Alpine Pass's arch, the sunlit snow cone lights the underside of the arch and the gorge wall:

![The arch bridge seen from the gorge, GI off on the left and GI on on the right: with GI the underside of the arch and the rock are lighter](https://files.threepipe.org/p/miniature-worlds/starter/readme/gi.jpg)

**A loop for your agent.** `npm run shot` renders converged stills with GI on and off in headless Chromium, so the
agent can look at its own frames, compare them with your reference and fix the largest defect, one pass at a time.

![The agent loop: brief, write the tile, render stills with GI on and off, look and compare, fix the largest defect, repeat](https://files.threepipe.org/p/miniature-worlds/starter/readme/loop.jpg)

## Start

Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev          # http://localhost:5173/?tile=alpine
```

The first load takes a while: the tile is generated in the browser (terrain, erosion, trees, materials) and the
Poly Haven textures and scans download. The console prints `alpine: setup in N s`.

Other commands:

```bash
npm run build        # type check and production build into dist/ (a static site)
npm run preview      # serve dist/
npm run typecheck    # TypeScript only
npm run shot:install # once: Chromium for the still renderer
npm run shot -- --tile alpine --views "Diorama,Bridge" --off 1   # stills with GI on and off into shots/alpine/
```

URL parameters: `?tile=<id>`, `?view=<name>`, `?time=<name>`, `?gi=0` (SSGI off), `?ui=0` (no panel),
`?scale=<x>` (render scale), `?shadow=<px>` (shadow map size), `?assets=<base>` (a local mirror of the remote files).

## Build a tile with an agent

You don't need to clone first. Send the tile prompt from [`GUIDE.md`](GUIDE.md#the-prompt) to your coding agent
(Claude Code, Codex, Cursor or another), in an empty folder or a web session, with a reference image: the prompt names
this repo, and the agent clones it, installs it and reads `AGENTS.md`. If you cloned it yourself:

1. Open this folder in your agent (for Claude Code: `claude` in this folder).
2. Give it a reference (a photo or a concept image) and the tile prompt from `GUIDE.md`, section "The prompt".
3. Keep `npm run dev` open in a browser tab with a GPU. The agent renders stills with `npm run shot`, but headless
   Chromium renders on the CPU; judge the look and the frame time in your own tab.
4. Critique with numbers and named defects ("the cliffs read as smooth blobs: add hard ledges and vertical joints",
   "the Bridge view is 37 ms: get it under 33"), one pass at a time.

## Layout

```
index.html, vite.config.ts, tsconfig.json
public/            the favicon (copied into dist/ as is)
src/
  main.ts          the viewer: plugins, the settings panel, views, times, ?tile=
  types.ts         the tile contract (Tile, TileResult)
  frameTime.ts     frame time of the current view (GPU timer query)
  tiles/index.ts   the tile registry: add new tiles here
  tiles/alpine.ts  the example tile: assembles the parts below into the scene
  tiles/alpine/    its landform and splat rules, materials, scatter rules, props
  kit/             the world kit (below)
scripts/shot.mjs   converged stills in headless Chromium, GI on and off
```

## The kit

Each file starts with a comment that says what it does and how. The example tile uses the first group; the second
group is type-checked but not used by it yet.

| File | What it gives you |
|---|---|
| `terrain.ts` | `buildTerrain`: a heightfield from a function, eroded, with up to four Poly Haven ground layers blended per pixel by a paint rule (height, slope, erosion masks). `terrain.height(x, z)` and `normalAt` for everything placed on it. |
| `erosion.ts` | Droplet hydraulic erosion and thermal slumping of the height grid, with flow, deposit, eroded and talus masks for the paint rule. |
| `terrainPatch.ts` | A cheaper terrain shader for tiles that fill the screen. |
| `beds.ts` | `buildCutFaces`: the four cut-away sides as rock beds that dip and fold, hard beds as ledges, turf and soil on top. |
| `scatter.ts` | `loadTemplate`, `instance`, `scatterOnTerrain`: seeded placement by a density rule, one draw call per mesh of a model. |
| `conifer.ts`, `tufts.ts` | Procedural instanced spruce, fir and larch; grass and flower tufts as cards. |
| `freshwater.ts`, `sea.ts` | A pond or tarn and a flowing creek along a path; the transmissive water they share. |
| `path.ts` | A road, track or creek through control points, with fast nearest-point queries (distance across, along, height). |
| `batch.ts`, `geo.ts` | Merged geometry per material with per-piece tint; rounded boxes, soft extrusions, vaults, domes, lathes. |
| `proc.ts`, `glslNoise.ts` | Procedural GLSL surfaces on threepipe's `PhysicalMaterial` (world space, no UVs); the GLSL noise library. |
| `vista.ts` | The land round the tile for eye-level views, fading into haze. |
| `stage.ts`, `lighting.ts`, `grade.ts` | The look: sun, sky fill, studio or sky backdrop, tone mapping, depth of field, colour grade, times of day. |
| `noise.ts` | Seeded PRNG (`rng`), 2D noise, fbm, ridged fbm, `smoothstep`. |
| `assets.ts`, `helpers.ts`, `gbuffer.ts` | Remote file URLs, plugin presets and camera helpers, the alpha-test fix for the G-buffer. |
| `strata.ts`, `surface.ts` | Sedimentary strata for canyon walls and cut faces traced per cell; procedural surfaces in the object's own frame with a seed per instance. |
| `waterBody.ts` | Water with a level per place (paddies, pools, falls), shallow and deep colour, opaque mode. |
| `heightFog.ts` | Valley mist that thins with height. |
| `grassTufts.ts` | Grass as blade geometry (no alpha test), translucent against a low sun. |
| `architecture.ts` | Buildings from boxes with thickness, Poly Haven surfaces in world-scaled UVs, merged per material. |
| `probe.ts`, `areaLights.ts` | Runtime light probes for rooms; emissive patches as area lights. |

## Differences from our hosted demo

- The hosted demo runs a newer SSGI from the *webgi* plugins' development branch (temporal denoising and a
  `maxScreenRadius` setting) than the published `@threepipe/webgi-plugins` 0.7.0 that this starter uses. The tile
  builds and renders with 0.7.0, but its GI and its frame times can differ from the demo: judge them in your tab.
- Video export (`CanvasRecorderPlugin`) is in threepipe 0.7 (prerelease); the starter stays on threepipe 0.6.0.
- The live demo is served as a sandboxed page (no localStorage, no Cache Storage). There it opens without the settings
  panel, because `@threepipe/plugin-tweakpane` 0.10.1 needs localStorage; pick a view and a time with `?view=` and
  `?time=` (for example `?view=Bridge`). On your own server or `npm run dev` the panel is there.

## Licence

The starter's code is under the Apache License 2.0 (`LICENSE`, `NOTICE`). `src/kit/glslNoise.ts` and parts of
`src/kit/proc.ts` and `src/kit/erosion.ts` are under the MIT licence. The *webgi* plugins package has its own licence
(GPL-3.0 with additional terms that allow free personal and commercial use of the free plugins). The tile's remote
assets are CC0 (Poly Haven). Details: `THIRD_PARTY_NOTICES.md`.
