# Home Area — Plan (office theme)

A "home" zone inside the office theme, same kind as `garage` and `rooftop bar`:
a distinct area with its own furniture and purpose, reachable and agent-capable.

## Concept

The office theme already has themed sub-areas (garage, rooftop bar, kitchen corner, loft,
meeting room). `home` is one more: a personal living space attached to the office, with a
butler agent for private tasks (reminders, personal notes, scheduling, private workers).

```
office theme
  ├── main office (desks, boards, whiteboard)
  ├── garage
  ├── rooftop bar
  ├── kitchen corner
  ├── loft / meeting room
  └── home  ← new area
```

## Implementation pattern (follow kitchen / balcony / loft)

1. **`src/client/world/home.ts`** — new module exporting `home: Fixture` (see `world/office/fixture.ts`).
2. **`src/client/world/office/build.ts`** — add `home` to `floorPlan()` array.
3. **Colliders + interactables** — register walls, furniture colliders, and any interactable (e.g. butler desk, personal terminal).
4. **Models** — Blender-built `.glb` files in `src/client/models/`, painted via `palette()` like `kitchen.glb`.
5. **Agent support** — home floor's workers are "butler" role; prompt carries private context. Reuse existing worker system; no new agent type needed, just a different default prompt/persona.

## Layout (enclosed room)

A self-contained room attached to the office (position TBD — south wall or east wing). Roughly
6 m × 5 m, walled with a door entry from the main office. Follows the meeting-room / loft
pattern (walls + door + colliders).

- **Entry** from the main office (door + short corridor)
- **Living area** (sofa, coffee table, TV, rug)
- **Kitchenette** (counter, fridge, espresso machine — reuse kitchen assets)
- **Study nook** (desk, chair, monitor, bookshelf)
- **Bedroom corner** (bed, nightstand, wardrobe) — optional, maybe v2
- **Butler station** (small desk with terminal, where the butler agent sits)

## 3D models needed

Each item is a Blender-built `.glb` in `src/client/models/`, painted with the office's
toon palette (see `world/models.ts` and `kitchen.ts` `COLORS` pattern). Dimensions are
approximate; final sizes set in Blender.

### Furniture (home.glb or split per piece)

| # | Model | Description | Est. size (m) | Notes |
|---|---|---|---|---|
| 1 | `home_sofa` | 3-seat sofa, fabric | 2.0 × 0.8 × 0.9 | living area |
| 2 | `home_coffee_table` | Low table, wood | 1.0 × 0.4 × 0.6 | in front of sofa |
| 3 | `home_tv` | Flat screen on stand | 1.2 × 0.7 × 0.1 | against wall |
| 4 | `home_rug` | Rectangular rug | 2.0 × 0.02 × 1.5 | under sofa/table |
| 5 | `home_bookshelf` | Tall shelf with books | 1.0 × 2.0 × 0.3 | study nook |
| 6 | `home_desk` | Writing desk, wood | 1.2 × 0.75 × 0.6 | study nook |
| 7 | `home_chair` | Office/desk chair | 0.6 × 1.0 × 0.6 | at desk |
| 8 | `home_counter` | Kitchen counter | reuse kitchen.glb | kitchenette |
| 9 | `home_fridge` | Retro fridge | reuse kitchen.glb | kitchenette |
| 10 | `home_coffee_machine` | Espresso machine | reuse kitchen.glb | kitchenette |
| 11 | `home_butler_desk` | Small terminal desk | 0.8 × 0.75 × 0.5 | butler station |
| 12 | `home_lamp_floor` | Floor lamp | 0.3 × 1.6 × 0.3 | living area |
| 13 | `home_lamp_desk` | Desk lamp | 0.2 × 0.4 × 0.2 | study nook |
| 14 | `home_plant` | Potted plant | 0.4 × 0.8 × 0.4 | corner decor |
| 15 | `home_painting` | Wall painting | 0.8 × 0.6 × 0.05 | wall decor |
| 16 | `home_door` | Interior door | 1.0 × 2.1 × 0.1 | entry from office |

### v2 (bedroom)

| # | Model | Description | Est. size (m) |
|---|---|---|---|
| 17 | `home_bed` | Single bed with headboard | 1.0 × 0.6 × 2.0 |
| 18 | `home_nightstand` | Small bedside table | 0.4 × 0.5 × 0.4 |
| 19 | `home_wardrobe` | Tall wardrobe | 1.2 × 2.0 × 0.6 |

### Reuse from existing assets

- `kitchen.glb` (counter, fridge, coffee machine) — already built
- `toon.ts` materials — all furniture painted with toon materials
- `models.ts` `model()` / `paintModel()` / `palette()` — same loading pattern

## Agent support (butler)

- Home floor can have workers (like any floor). The "butler" is **auto-hired** on first visit to the home floor if no butler worker exists, with a personal-context prompt (reminders, personal notes, scheduling, private task queue).
- Butler capabilities: reminders, personal notes, scheduling, private task queue.
- No new agent type needed — reuse `hire_worker` with a butler persona prompt.
- Butler workers live in `agent-office/.agent-office/` (home's own data dir, which is the office's home data dir).

## Files to create/modify

| File | Action |
|---|---|
| `src/client/world/home.ts` | New — home area fixture (follow kitchen.ts pattern) |
| `src/client/world/office/build.ts` | Add `home` to floorPlan() |
| `src/client/models/home.glb` | New — Blender model (or split per piece) |
| `blender/scripts/build_home.py` | New — Blender build script (follow build_kitchen.py) |
| `src/client/world/office/types.ts` | Add home interactables to OfficeHandles if needed |

## Constraints

- Size guard: new files must be ≤ 600 lines (`tests/size.test.ts`)
- `tests/client-structure.test.ts` checks `main.ts` calls every feature's install once — home is part of the office floor, not a separate feature, so no new install line needed
- Model files (.glb) are assets, not counted by size guard

## Open questions (decided)

1. **Enclosed room** ✅ — home is a walled room with a door, not an open area. Follows the meeting-room / loft pattern (walls + door).
2. **Bedroom in v2** ✅ — v1 ships living area + kitchenette + study nook + butler station. Bedroom (bed, nightstand, wardrobe) deferred to v2.
3. **Auto-hire butler** ✅ — on first visit to the home floor, if no butler worker exists, hire one automatically with a butler persona prompt. Butler lives in `agent-office/.agent-office/`.
4. **Position: TBD** — still planning. Candidate: south wall (like kitchen) or east wing. Decide during layout.
