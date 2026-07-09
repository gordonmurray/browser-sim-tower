# Architecture

Design notes for the tower simulation. The guiding principle is one line: **the
simulation is pure TypeScript with zero rendering dependencies.** Everything
else follows from that.

## The core / view split

```
Input (Phaser) --> Commands --> Core engine (pure TS) --> State
                                                            |
Render (Phaser) <-- reads state <---------------------------
```

Nothing under `src/core` or `src/save` imports from `phaser` or from
`src/game`. The core runs headless in Node, so the whole rule system and
economy are property-tested with fast-check without a browser. Phaser is a thin
layer on top that reads simulation state and renders it, and translates input
into commands. Rendering can be rewritten or swapped without touching a single
rule. An ESLint import-boundary rule fails lint on violations.

### Directory layout

```
src/
  core/              # pure TS. No phaser imports anywhere below here.
    state.ts         # TowerState: the whole simulation as plain data
    engine.ts        # headless orchestrator: applyCommand(), tick()
    grid/            # cell grid, coordinates, occupancy
    rooms/           # room type definitions, sizes, costs, income model
    rules/           # placement predicates + the command validator
    sim/             # the tick systems, run in a fixed order
      time.ts        # sim clock, day/night, weekday vs weekend
      tenants.ts     # occupancy, trip generation
      transport/     # reachability + elevator routing
      economy.ts     # costs, income, quarterly collection
      population.ts  # population count, star rating, unlocks
  save/
    schema.ts        # versioned persisted types
    migrations.ts    # migrate_vN_to_vNplus1 functions + a runner
    storage.ts       # localStorage read/write, calls migrations on load
  game/              # Phaser only.
    scenes/
    render/          # draws TowerState onto the grid
    input/           # translates clicks/drags into core Commands
    ui/              # money, date, star, population panels, speed controls
    environment/     # weather + time-of-day backdrop (external data, view only)
  main.ts
tests/
```

### Commands

All state changes go through the engine as explicit commands (`PlaceRoom`,
`PlaceElevatorShaft`, `Demolish`, `SetSpeed`, …). The engine validates and
applies them; the view never mutates state directly. One clear entry point for
rules, and actions stay easy to test, log, or replay.

## Domain model

- **Grid:** a 2D grid of cells. X is horizontal position, Y is floor. Floors
  below 0 are basement (underground).
- **Floor:** a horizontal level. A cell can be structure or empty. Rooms sit on
  a floor and occupy a contiguous run of cells.
- **Room:** has a type, a width in cells, a height in floors, a build cost, and
  an income model. Rooms have occupancy and a satisfaction value.
- **Transport:** elevator shafts (a vertical range with one or more cars),
  stairs, and escalators (short vertical links between adjacent floors).

### Room categories

- **Lobby:** required on the ground floor. Connects transport and foot traffic.
- **Office:** business tenant. Pays rent quarterly. Occupied on weekdays,
  largely empty at night and weekends. Sensitive to elevator wait time.
- **Condo:** residence. Sold once for a lump sum, then occupied long term.
  Leaves only if satisfaction stays very low.
- **Hotel (single / double / suite):** income per occupied night. Needs
  housekeeping within range.
- **Retail (fast food, shop, restaurant):** income driven by customer visits
  and foot traffic. Placement near traffic matters.
- **Support (housekeeping, security, medical, recycling):** unlock with star
  rating, serve nearby rooms, cost upkeep.
- **Parking (underground):** improves appeal and occupancy of offices and
  retail. The reason to build down.

## Placement rules

Every rule is a small, named predicate in `src/core/rules`. A command validator
runs the full set before any placement is applied. Each predicate takes the
current state and the proposed placement and returns pass or a typed failure
reason. Rules are data-driven where possible so new room types add a definition
rather than a new branch.

1. A lobby must exist on the ground floor before anything is built above it.
2. A room only occupies cells on a floor that exists; a room never floats.
3. Rooms may not overlap another room or a transport shaft.
4. A room fits within the tower bounds and any per-star height limit.
5. **Reachability:** every functional room must have a transport path
   (elevators / stairs / escalators / lobbies) to the ground lobby.
   Unreachable rooms do not function.
6. An elevator shaft spans a contiguous vertical range and only serves floors
   within that range that have a landing.
7. Underground rooms follow the same reachability rule.
8. Star-gated types cannot be placed until their population threshold is met.
9. Noise adjacency: noise-sensitive rooms may not sit next to noisy ones.

## Simulation

A fixed-timestep loop. Sim time advances in sim-minutes; a configurable number
of real milliseconds maps to one sim-minute, with speed controls. Rendering
interpolates; the simulation itself is deterministic and independent of frame
rate.

Each tick runs systems in a fixed order:

1. **time** — advance the clock, roll day/night and weekday/weekend, fire
   quarter boundaries.
2. **tenants** — update occupancy, generate trips based on room type and time.
3. **transport** — route trips, update reachability, assign elevator cars.
4. **satisfaction** — update per-room and per-tenant satisfaction, driven
   mainly by elevator wait time.
5. **economy** — apply income and costs. Rent collects on quarter boundaries;
   hotels settle per night; retail accrues from visits.
6. **population** — recompute population, update star rating, apply unlocks.

**Determinism:** the simulation is reproducible from a given state plus a seeded
RNG stored in state. Nothing in the core calls `Math.random()`. This makes
property tests and save round-tripping meaningful.

### Elevators

Elevator routing is the core difficulty of the genre and is isolated behind a
clear interface in `sim/transport`. It uses a collective-control / SCAN-style
algorithm: a car sweeps in one direction serving requests, then reverses. Hard
invariants, enforced here and property-tested: a car never exceeds capacity,
never leaves its shaft's vertical range, and never strands a passenger for whom
a serving car exists. Wait time feeds satisfaction, which feeds move-outs and
income — the central feedback loop.

## Environment backdrop (weather and time of day)

The scenery behind the tower reflects the player's real local weather and local
time. This is a view-layer concern only: it never touches tenants, economy,
satisfaction, or saved state, which keeps the core deterministic. It lives in
`src/game/environment`.

- **Location:** the browser Geolocation API for coarse coordinates (prompts for
  permission). If denied, falls back to a manual city, then a sensible default.
  The game never blocks on location.
- **Weather data:** [Open-Meteo](https://open-meteo.com) — free, no API key,
  CORS-friendly, so it is called directly from the browser with no backend. A
  WMO weather code plus an `is_day` flag map to a small set of backdrop states.
- **Refresh:** polled on a timer (every 15–30 minutes), never per tick. The
  last result is cached; on network failure the last known state persists.
- **Day/night source:** a one-line config flag (`skyFollows`) decides whether
  the sky follows real local time (default) or the accelerated sim clock.

The game is fully playable with weather unavailable — it is the only part of the
app that needs the network or a browser permission.

## Save format

- Persisted to localStorage as JSON under a stable key.
- The top-level object carries a `saveVersion` integer.
- On load, `storage.ts` runs the save through the migration chain in
  `migrations.ts` up to the current version before handing it to the engine.
  Old fields are never read directly.
- Each schema change adds one `migrate_vN_to_vNplus1` function and bumps the
  version. Migrations are pure and tested.

## Testing

Vitest for unit tests, fast-check for property-based tests over the pure core.
Property tests are the main tool for the rule system: generate thousands of
random valid command sequences and assert invariants hold. Key invariants:

- After any sequence of accepted placements, no two rooms overlap.
- Every accepted placement satisfies all rule predicates.
- An elevator car never exceeds capacity and never leaves its shaft range.
- Money reflects the rules the game enforces (construction never overdraws).
- **Save round-trip:** serialise state, deserialise it, and the resulting
  simulation is identical and continues to tick identically.

## Conventions

- **Keep the core free of rendering.** If a change tempts you to import Phaser
  under `src/core`, the design is wrong — stop and reconsider.
- **Schema changes via migration only.** Never change the shape of persisted
  state without adding a migration; never mutate an old save in place on load.
- **Determinism first.** No `Math.random()` in the core; use the seeded RNG in
  state. Never tie simulation speed to frame rate.
- **localStorage is small and synchronous.** Keep saves compact; write on
  meaningful events or a throttle, not every tick.
- **The weather backdrop is external, live, view-only ambience.** It must not
  reach into the core or saved state.
