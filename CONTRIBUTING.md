# Contributing

Thanks for your interest! Bug reports, ideas, and pull requests are all welcome.

## Getting set up

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest + fast-check
npm run lint       # ESLint (incl. the core/Phaser import boundary)
npm run build      # tsc --noEmit + production build
```

Please make sure `npm test`, `npm run lint`, and `npm run build` all pass before
opening a pull request. CI runs the same three on every push.

## A few house rules

These keep the project easy to reason about — see
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the why:

- **Keep the simulation core free of Phaser.** Nothing under `src/core` or
  `src/save` may import from `phaser` or `src/game`. The lint step enforces this.
- **Determinism matters.** No `Math.random()` in the core — use the seeded RNG
  in state. Don't tie simulation speed to frame rate.
- **Persisted state changes need a migration.** If you change the shape of the
  save (`src/save/schema.ts`), add a `migrate_vN_to_vNplus1` and bump the
  version. Keep the save round-trip test green.
- **New room types are data, not branches.** Add a definition in
  `src/core/rooms/catalog.ts` (and any type-specific predicate in
  `src/core/rules`) rather than scattering conditionals through the engine.

## Reporting bugs

Open an issue with steps to reproduce. If it's a simulation bug, the seed and
the sequence of actions (or an exported save) make it much easier to track down.
