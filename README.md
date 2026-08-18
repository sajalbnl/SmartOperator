# SmartOperator

SmartOperator is an offline-first Android prototype for capturing factory knowledge on unreliable networks. Operators record expert guidance, uploads recover automatically, reviewers approve the generated procedure, and Ask uses that knowledge with citations.

The prototype is scoped to machine `CNC-042`.

## How it works

```text
Android capture → SQLite queue → multipart S3 upload
→ Whisper transcript → Claude procedure draft → human approval
→ keyword retrieval → Claude answer with validated citations
```

Key behavior:

- Records while offline and stores work in an app-private SQLite queue.
- Uploads in 5 MiB parts and resumes after reconnects or app restarts.
- Keeps unapproved knowledge out of Ask results.
- Retries incomplete AI responses and validates citations.

## Stack

Expo, React Native, CameraX, SQLite, Node.js, Express, Supabase Postgres, S3, OpenAI Whisper, Anthropic Claude, Docker, Railway, and EAS.

## Run locally

The server needs `DATABASE_URL`, AWS credentials and bucket details, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`.

Server:

```sh
cd server
npm install
npm run migrate
npm run seed
npm run dev
```

Android app:

```sh
cd app
npm install
npm run start
```

Set `EXPO_PUBLIC_API_URL` to a reachable server URL. A physical phone cannot use the computer's `localhost`. The native recorder requires a development build or APK; Expo Go is not supported.

## Verify and build

```sh
cd server
npm run typecheck
npm test
npm run build

cd ../app
npm run typecheck
npm run doctor
npx eas-cli@latest build --platform android --profile preview
```

Reset captured data while keeping seeded SOPs:

```sh
cd server
npm run reset:demo              # dry run
npm run reset:demo -- --confirm # destructive
```

## Production API

- API: https://smartoperator-api-production.up.railway.app
- Health: https://smartoperator-api-production.up.railway.app/health

Deploy from `server/`:

```sh
npx @railway/cli up . --path-as-root --service smartoperator-api --environment production
```

## Current scope

Android only, one machine, internal distribution, no authentication, keyword retrieval instead of vector search, and a single-process processing queue.
