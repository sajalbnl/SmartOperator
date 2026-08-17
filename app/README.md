# SmartOperator Android app

Android-only Expo development-client app for offline-first factory video capture.

Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_URL` to the Express
server's HTTPS base URL. A physical phone cannot reach a server at `localhost`;
for local testing use the computer's LAN IP and ensure Android permits the
chosen transport (HTTPS is strongly preferred).

## Why a development build is required

The app includes an Android camera/microphone foreground service and a local
CameraX recorder module. Expo Go cannot load either native addition. Permissions
and the idle preview use `expo-camera`. During recording, the foreground service
owns both CameraX video capture and a native preview surface, so the image stays
live while the Activity is visible and recording continues while backgrounded
or with the screen locked.

## EAS profiles

`eas.json` contains two Android APK profiles:

- `development`: includes `expo-dev-client` and developer tools. This is the
  Phase 2 physical-device build.
- `preview`: internal-distribution APK without the development client, reserved
  for later production-like testing.

Both use internal distribution and explicitly produce an installable APK rather
than a Play Store AAB.

## Build and install

The EAS project is linked in `app.json`. Submit the development APK from this
directory:

```sh
npx eas-cli@latest build --platform android --profile development
```

When it completes, open the EAS build URL on the Android phone and tap
**Install**, allowing installs from the browser when Android asks. With USB
debugging enabled, the downloaded artifact can instead be installed with:

```sh
adb install -r /absolute/path/to/smartoperator-development.apk
```

Start Metro for the installed development client:

```sh
npm install
npm run start
```

The computer and phone should be on the same network. Press `s` in Expo CLI if
it is not already targeting a development build, then open SmartOperator on the
phone and select the discovered development server.

## Physical-device acceptance test

1. Grant camera, microphone, and notification permissions.
2. Start a capture and confirm the persistent **Recording CNC-042** notification.
3. After 15 seconds, press Home, then lock the screen for at least 20 seconds.
4. Unlock and return to SmartOperator. Let the total recording reach 60–90
   seconds, then stop it.
5. Confirm the UI shows a non-zero duration, a sensible multi-megabyte size,
   and a private path under `files/captures/`.
6. Navigate through Capture, Review, and Ask; Ask remains intentionally deferred.

## Phase 3 kill/recovery acceptance test

1. Start the backend and confirm the phone can reach its `/health` endpoint.
2. Turn airplane mode on and record three captures. SQLite rows and 5 MB byte
   ranges must appear immediately as `pending` / `OFFLINE QUEUED`.
3. Turn airplane mode off. While a part is `uploading`, swipe the app away.
4. Reopen SmartOperator. Do not tap anything: cold-start `/resume` must refresh
   URLs and the queue must drain through `done` to capture `DONE`.
5. Repeat three consecutive times, then compare device SQLite with Postgres and
   verify each assembled S3 object has the capture's exact byte size.

Useful device inspection commands:

```sh
adb shell run-as com.smartoperator.capture ls -lh files/captures
adb shell run-as com.smartoperator.capture ls databases
adb shell am force-stop com.smartoperator.capture
adb exec-out run-as com.smartoperator.capture cat databases/smartoperator-queue.db > /tmp/smartoperator-queue.db
sqlite3 /tmp/smartoperator-queue.db '.mode box' 'select server_id,status,total_bytes,last_error from captures order by created_at;'
sqlite3 /tmp/smartoperator-queue.db '.mode box' 'select capture_id,part_number,state,attempts,last_error from chunks order by capture_id,part_number;'
```

## Phase 4 transcription/review acceptance test

1. Run `npm run migrate` in `server/`, then start the backend with the OpenAI
   and Anthropic keys configured. The server bundles ffmpeg for audio extraction.
2. Record: “When it vibrates after a bearing replacement, check coolant
   contamination before you replace the bearing again.”
3. After upload, watch the Capture card advance through uploaded, transcribing,
   structuring, and ready for review.
4. Open Review and inspect the transcript and draft. Confirm both the visible
   **← Drafts** control and Android system Back return to the pending list.
5. Approve one draft with **Approve and add to knowledge base**. Confirm the
   success state, `procedures.approved = true`, and `rejected_at IS NULL`.
6. Open another draft and choose **Reject draft**. Confirm the warning, then
   reject it. It must leave the pending list and remain in Postgres with
   `approved = false` and `rejected_at IS NOT NULL`.
7. In `server/`, run `npm run verify:review-decisions` while the backend is
   running. This proves repeated decisions are idempotent, opposite decisions
   return `409`, and reviewed drafts are filtered correctly.
8. To exercise pipeline failure recovery, call `POST /captures/:id/pipeline/retry` for a
   failed capture. The unique `capture_id` constraints keep transcript and
   procedure row counts at one.

For a debug-level disk check while the phone is connected:

```sh
adb shell run-as com.smartoperator.capture ls -lh files/captures
```
