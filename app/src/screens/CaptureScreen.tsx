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
import {
  enqueueCapture,
  loadQueueSnapshot,
  subscribeToQueue,
} from '../queue/database';
import { durableUploader, type UploaderSnapshot } from '../queue/uploader';
import type { CaptureQueueItem, ChunkState, QueueSnapshot } from '../queue/types';

type CaptureDetails = {
  durationMillis: number;
  path: string;
  size: number;
};

const EMPTY_QUEUE: QueueSnapshot = { captures: [], unfinishedCount: 0 };

function captureDisplayId(capture: CaptureQueueItem) {
  return capture.server_id ? `CAP-${capture.server_id}` : `LOCAL-${capture.id.slice(-5)}`;
}

function captureRollup(capture: CaptureQueueItem) {
  if (capture.status === 'done') {
    return 'DONE';
  }
  if (!capture.server_id) {
    return capture.status === 'failed' ? 'REGISTER RETRY' : 'OFFLINE QUEUED';
  }
  if (capture.status === 'completing') {
    return 'ASSEMBLING';
  }
  if (capture.chunks.every((chunk) => chunk.state === 'done')) {
    return capture.status === 'failed' ? 'ASSEMBLY RETRY' : 'READY TO ASSEMBLE';
  }
  if (capture.chunks.some((chunk) => chunk.state === 'uploading')) {
    return 'UPLOADING';
  }
  if (capture.chunks.some((chunk) => chunk.state === 'failed')) {
    return 'RETRY BACKOFF';
  }
  return 'QUEUED';
}

function stateColor(state: ChunkState) {
  switch (state) {
    case 'done':
      return '#247A51';
    case 'uploading':
      return '#1769AA';
    case 'failed':
      return '#A9321A';
    default:
      return '#6B716E';
  }
}

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
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE);
  const [uploader, setUploader] = useState<UploaderSnapshot>(durableUploader.getSnapshot());

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
    await enqueueCapture({
      durationMillis: result.durationMillis,
      fileUri: result.uri,
      machineId: 'CNC-042',
      operatorId: 'operator-demo',
      totalBytes: size,
    });
    durableUploader.wake();
    setLastCapture({
      durationMillis: result.durationMillis,
      path: result.uri,
      size,
    });
    setDurationMillis(result.durationMillis);
    setIsRecording(false);
    recordingStartedAt.current = null;
  }, []);

  useEffect(() => {
    let active = true;
    const reload = () => {
      void loadQueueSnapshot()
        .then((snapshot) => {
          if (active) {
            setQueue(snapshot);
          }
        })
        .catch((caught) => {
          if (active) {
            setError(caught instanceof Error ? caught.message : 'Could not read upload queue.');
          }
        });
    };
    reload();
    const unsubscribeQueue = subscribeToQueue(reload);
    const unsubscribeUploader = durableUploader.subscribe(() => {
      if (active) {
        setUploader(durableUploader.getSnapshot());
      }
    });
    return () => {
      active = false;
      unsubscribeQueue();
      unsubscribeUploader();
    };
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

      <View style={styles.queueHeader}>
        <View>
          <Text style={styles.queueEyebrow}>DURABLE SQLITE QUEUE</Text>
          <Text style={styles.queueTitle}>
            {queue.unfinishedCount} unfinished / {queue.captures.length} captures
          </Text>
        </View>
        <View
          style={[
            styles.networkPill,
            uploader.connectivity === 'server-ready' && styles.networkPillReady,
            uploader.connectivity === 'offline' && styles.networkPillOffline,
          ]}
        >
          <Text style={styles.networkPillText}>
            {uploader.connectivity === 'server-ready'
              ? 'SERVER OK'
              : uploader.connectivity === 'offline'
                ? 'OFFLINE'
                : 'CHECKING'}
          </Text>
        </View>
      </View>
      <Text style={styles.uploaderDetail}>{uploader.detail}</Text>

      {queue.captures.length === 0 ? (
        <View style={styles.emptyQueue}>
          <Text style={styles.debugEmpty}>No captures queued yet.</Text>
        </View>
      ) : (
        queue.captures.map((capture) => (
          <View key={capture.id} style={styles.captureQueueCard}>
            <View style={styles.captureQueueHeader}>
              <Text style={styles.captureId}>{captureDisplayId(capture)}</Text>
              <Text style={styles.captureRollup}>{captureRollup(capture)}</Text>
            </View>
            <Text style={styles.captureMeta}>
              {formatDuration(capture.duration_s * 1_000)} · {formatBytes(capture.total_bytes)} ·{' '}
              {capture.chunks.filter((chunk) => chunk.state === 'done').length}/
              {capture.chunks.length} parts
            </Text>
            {capture.last_error ? (
              <Text selectable style={styles.captureError}>
                {capture.last_error}
              </Text>
            ) : null}

            <View style={styles.chunkTableHeader}>
              <Text style={[styles.chunkCell, styles.partCell]}>PART</Text>
              <Text style={[styles.chunkCell, styles.stateCell]}>STATE</Text>
              <Text style={[styles.chunkCell, styles.attemptCell]}>TRIES</Text>
            </View>
            {capture.chunks.map((chunk) => (
              <View key={chunk.id} style={styles.chunkBlock}>
                <View style={styles.chunkRow}>
                  <Text style={[styles.chunkValue, styles.partCell]}>#{chunk.part_number}</Text>
                  <Text
                    style={[
                      styles.chunkValue,
                      styles.stateCell,
                      { color: stateColor(chunk.state) },
                    ]}
                  >
                    {chunk.state.toUpperCase()}
                  </Text>
                  <Text style={[styles.chunkValue, styles.attemptCell]}>{chunk.attempts}</Text>
                </View>
                <Text style={styles.rangeText}>
                  bytes {chunk.byte_start}–{chunk.byte_end}
                </Text>
                {chunk.last_error ? (
                  <Text selectable style={styles.chunkError}>
                    {chunk.last_error}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ))
      )}
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
  queueHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
  },
  queueEyebrow: {
    color: colors.signal,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  queueTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 4,
  },
  networkPill: {
    backgroundColor: '#DED9CC',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  networkPillReady: {
    backgroundColor: '#CDE9D9',
  },
  networkPillOffline: {
    backgroundColor: '#F4D8CF',
  },
  networkPillText: {
    color: colors.ink,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  uploaderDetail: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
    marginTop: 6,
  },
  emptyQueue: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  captureQueueCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 12,
    overflow: 'hidden',
    padding: 14,
  },
  captureQueueHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  captureId: {
    color: colors.ink,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 16,
    fontWeight: '900',
  },
  captureRollup: {
    color: colors.signal,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  captureMeta: {
    color: colors.textMuted,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 11,
    marginBottom: 10,
    marginTop: 5,
  },
  captureError: {
    color: '#A9321A',
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 10,
    lineHeight: 15,
    marginBottom: 8,
  },
  chunkTableHeader: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingBottom: 6,
  },
  chunkCell: {
    color: colors.textMuted,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 9,
    fontWeight: '900',
  },
  partCell: {
    width: 52,
  },
  stateCell: {
    flex: 1,
  },
  attemptCell: {
    textAlign: 'right',
    width: 44,
  },
  chunkBlock: {
    borderBottomColor: '#ECE8DE',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 7,
  },
  chunkRow: {
    flexDirection: 'row',
  },
  chunkValue: {
    color: colors.ink,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 11,
    fontWeight: '800',
  },
  rangeText: {
    color: colors.textMuted,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 9,
    marginTop: 3,
  },
  chunkError: {
    color: '#A9321A',
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 9,
    lineHeight: 14,
    marginTop: 4,
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
