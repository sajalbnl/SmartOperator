# SmartOperator Android app

Android-only Expo development-client app for factory video capture.

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
6. Navigate through Capture, Review, and Ask; the latter two are intentionally
   labeled placeholders in this phase.

For a debug-level disk check while the phone is connected:

```sh
adb shell run-as com.smartoperator.capture ls -lh files/captures
```
