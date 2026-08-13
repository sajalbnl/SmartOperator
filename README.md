# SmartOperator

Offline-first Android capture prototype for machine `CNC-042`.

## Repository layout

- `server/` — Express and TypeScript backend
- `app/` — Android app placeholder until Phase 2
- `seed/` — hand-authored SOP markdown
- `PHASE_0_SETUP.md` — external service setup and verification

## Phase 0 commands

Run commands from `server/`:

```sh
npm install
npm run typecheck
npm run migrate
npm run seed -- --dry-run
npm run seed
npm run verify:s3
npm run verify:openai
npm run verify:anthropic
```

Copy credentials into `server/.env` before commands that use external services. Review the SOPs, especially `SOP-MCH-042`, before running the non-dry-run seed command.

