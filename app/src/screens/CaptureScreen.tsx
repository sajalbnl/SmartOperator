import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import BackgroundVideoRecorder, {
  BackgroundVideoRecorderView,
  type RecordingResult,
} from '../../modules/background-video-recorder';
import { colors } from '../theme';

type CaptureDetails = {
  durationMillis: number;
  path: string;
  size: number;
};

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.floor(durationMillis / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export function CaptureScreen() {
  const cameraRef = useRef<CameraView>(null);
  const recordingStartedAt = useRef<number | null>(null);
  const stopInProgress = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [durationMillis, setDurationMillis] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [lastCapture, setLastCapture] = useState<CaptureDetails | null>(null);

  const hasPermissions =
    cameraPermission?.granted === true && microphonePermission?.granted === true;

  const requestPermissions = useCallback(async () => {
    setError(null);
    const camera = await requestCameraPermission();
    const microphone = await requestMicrophonePermission();
    if (!camera.granted || !microphone.granted) {
      setError('Camera and microphone access are both required to record.');
    }
  }, [requestCameraPermission, requestMicrophonePermission]);

  const acceptResult = useCallback(async (result: RecordingResult) => {
    const file = new File(result.uri);
    const size = file.exists ? file.size : result.size;
    setLastCapture({
      durationMillis: result.durationMillis,
      path: result.uri,
      size,
    });
    setDurationMillis(result.durationMillis);
    setIsRecording(false);
    recordingStartedAt.current = null;
  }, []);

  const stopRecording = useCallback(async () => {
    if (stopInProgress.current) {
      return;
    }
    stopInProgress.current = true;
    setError(null);
    try {
      const result = await BackgroundVideoRecorder.stopRecording();
      await acceptResult(result);
    } catch (caught) {
      setIsRecording(false);
      recordingStartedAt.current = null;
      setError(caught instanceof Error ? caught.message : 'Could not stop the recording.');
    } finally {
      stopInProgress.current = false;
    }
  }, [acceptResult]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }
    const updateDuration = () => {
      if (recordingStartedAt.current !== null) {
        setDurationMillis(Date.now() - recordingStartedAt.current);
      }
    };
    updateDuration();
    const timer = setInterval(updateDuration, 250);
    return () => clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' || !isRecording) {
        return;
      }
      const status = BackgroundVideoRecorder.getStatus();
      if (!status.isRecording) {
        void stopRecording();
      }
    });
    return () => subscription.remove();
  }, [isRecording, stopRecording]);

  const startRecording = useCallback(async () => {
    if (!hasPermissions || !cameraReady || isRecording || isStartingRecording) {
      return;
    }

    setError(null);
    setLastCapture(null);
    setDurationMillis(0);

    try {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }

      const capturesDirectory = new Directory(Paths.document, 'captures');
      capturesDirectory.create({ idempotent: true, intermediates: true });
      const output = new File(
        capturesDirectory,
        `cnc-042-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.mp4`,
      );

      // Release Expo Camera's Activity-bound CameraX session before the service
      // binds the same camera. Unmounting alone can race its native cleanup and
      // unbind the service's newly-created use cases on some physical devices.
      await cameraRef.current?.pausePreview();
      setIsStartingRecording(true);
      setCameraReady(false);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      await BackgroundVideoRecorder.startRecording(output.uri);
      recordingStartedAt.current = Date.now();
      setIsRecording(true);
      setIsStartingRecording(false);
    } catch (caught) {
      setIsStartingRecording(false);
      setError(caught instanceof Error ? caught.message : 'Could not start recording.');
    }
  }, [cameraReady, hasPermissions, isRecording, isStartingRecording]);

  const nativeRecorderOwnsCamera = isStartingRecording || isRecording;

  if (!cameraPermission || !microphonePermission) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.permissionTitle}>Checking camera access…</Text>
      </View>
    );
  }

  if (!hasPermissions) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.permissionTitle}>Camera access required</Text>
        <Text style={styles.permissionCopy}>
          SmartOperator records video and voice into private app storage.
        </Text>
        <Pressable onPress={requestPermissions} style={styles.permissionButton}>
          <Text style={styles.permissionButtonLabel}>Allow camera and microphone</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>MACHINE</Text>
          <Text style={styles.machine}>CNC-042</Text>
        </View>
        <View style={[styles.statusPill, nativeRecorderOwnsCamera && styles.statusPillRecording]}>
          <View style={[styles.statusDot, nativeRecorderOwnsCamera && styles.statusDotRecording]} />
          <Text style={[styles.statusText, nativeRecorderOwnsCamera && styles.statusTextRecording]}>
            {isStartingRecording ? 'STARTING' : isRecording ? 'RECORDING' : 'READY'}
          </Text>
        </View>
      </View>

      <View style={styles.cameraFrame}>
        {nativeRecorderOwnsCamera ? (
          <BackgroundVideoRecorderView style={StyleSheet.absoluteFill} />
        ) : (
          <CameraView
            facing="back"
            mode="video"
            onCameraReady={() => setCameraReady(true)}
            onMountError={(event) => setError(event.message)}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            videoQuality="720p"
          />
        )}
        <View pointerEvents="none" style={styles.cameraOverlay}>
          <Text style={styles.duration}>{formatDuration(durationMillis)}</Text>
          {isRecording ? (
            <Text style={styles.backgroundHint}>Safe to lock or background the phone</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.controls}>
        <Pressable
          accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
          disabled={isStartingRecording || (!cameraReady && !isRecording)}
          onPress={isRecording ? stopRecording : startRecording}
          style={({ pressed }) => [
            styles.recordButtonOuter,
            pressed && styles.recordButtonPressed,
            (isStartingRecording || (!cameraReady && !isRecording)) &&
              styles.recordButtonDisabled,
          ]}
        >
          <View style={[styles.recordButtonInner, isRecording && styles.stopButtonInner]} />
        </Pressable>
        <Text style={styles.controlLabel}>{isRecording ? 'STOP CAPTURE' : 'START CAPTURE'}</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.debugCard}>
        <Text style={styles.debugTitle}>LAST LOCAL CAPTURE</Text>
        {lastCapture ? (
          <>
            <View style={styles.debugRow}>
              <Text style={styles.debugKey}>Duration</Text>
              <Text style={styles.debugValue}>{formatDuration(lastCapture.durationMillis)}</Text>
            </View>
            <View style={styles.debugRow}>
              <Text style={styles.debugKey}>Size</Text>
              <Text style={styles.debugValue}>{formatBytes(lastCapture.size)}</Text>
            </View>
            <Text style={styles.debugKey}>Private path</Text>
            <Text selectable style={styles.path}>
              {lastCapture.path}
            </Text>
          </>
        ) : (
          <Text style={styles.debugEmpty}>Stop a recording to inspect its file.</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.canvas,
    flexGrow: 1,
    padding: 20,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  eyebrow: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  machine: {
    color: colors.ink,
    fontSize: 32,
    fontWeight: '800',
    marginTop: 4,
  },
  statusPill: {
    alignItems: 'center',
    backgroundColor: '#E3E6DF',
    borderRadius: 999,
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusPillRecording: {
    backgroundColor: '#FCE5DE',
  },
  statusDot: {
    backgroundColor: '#6D7A73',
    borderRadius: 99,
    height: 7,
    marginRight: 7,
    width: 7,
  },
  statusDotRecording: {
    backgroundColor: colors.signal,
  },
  statusText: {
    color: '#52605A',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  statusTextRecording: {
    color: '#9F351D',
  },
  cameraFrame: {
    backgroundColor: colors.ink,
    borderRadius: 24,
    height: 350,
    marginTop: 18,
    overflow: 'hidden',
  },
  cameraOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  duration: {
    color: colors.panel,
    fontSize: 46,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 2,
    textShadowColor: '#00000080',
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
  },
  backgroundHint: {
    backgroundColor: '#101614B8',
    borderRadius: 999,
    color: colors.panel,
    fontSize: 12,
    marginTop: 14,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  controls: {
    alignItems: 'center',
    marginVertical: 20,
  },
  recordButtonOuter: {
    alignItems: 'center',
    borderColor: colors.ink,
    borderRadius: 999,
    borderWidth: 4,
    height: 86,
    justifyContent: 'center',
    width: 86,
  },
  recordButtonPressed: {
    opacity: 0.62,
    transform: [{ scale: 0.97 }],
  },
  recordButtonDisabled: {
    opacity: 0.35,
  },
  recordButtonInner: {
    backgroundColor: colors.signal,
    borderRadius: 999,
    height: 66,
    width: 66,
  },
  stopButtonInner: {
    borderRadius: 10,
    height: 40,
    width: 40,
  },
  controlLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: 10,
  },
  debugCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  debugTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 12,
  },
  debugRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  debugKey: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  debugValue: {
    color: colors.ink,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  debugEmpty: {
    color: colors.textMuted,
    fontSize: 14,
  },
  path: {
    color: colors.ink,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 11,
    lineHeight: 17,
    marginTop: 6,
  },
  permissionTitle: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  permissionCopy: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    maxWidth: 320,
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor: colors.ink,
    borderRadius: 14,
    marginTop: 22,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  permissionButtonLabel: {
    color: colors.panel,
    fontSize: 14,
    fontWeight: '700',
  },
  error: {
    color: '#A9321A',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
    textAlign: 'center',
  },
});
