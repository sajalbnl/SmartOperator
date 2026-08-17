# SmartOperator

Offline-first Android capture prototype for machine `CNC-042`.

## Repository layout

- `server/` — Express and TypeScript backend
- `app/` — Android Expo dev-client app with durable capture queue and Review gate
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

## Phase 4 pipeline

The upload-complete endpoint now starts a serialized, restart-safe in-process
pipeline: S3 download → bundled ffmpeg audio extraction → Whisper transcription
→ strict Claude procedure draft. Run `npm run migrate` after pulling changes.

Review APIs:

- `GET /captures/:id/pipeline`
- `POST /captures/:id/pipeline/retry`
- `GET /procedures?review_status=pending`
- `POST /procedures/:id/approve`
- `POST /procedures/:id/reject`

The Android Capture screen polls pipeline state, and Review renders the transcript
and draft before exposing mutually exclusive Approve and Reject actions. Rejection
is retained for audit but excluded from pending and approved knowledge. Run
`npm run verify:review-decisions` with the server running to verify idempotency,
conflict handling, and filtered lists. Ask/retrieval remain deferred to Phase 5.
