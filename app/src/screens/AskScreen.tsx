import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { askWithAudio, type AskResult } from '../queue/api';
import { colors } from '../theme';

type Props = {
  isActive: boolean;
};

type AskPhase = 'idle' | 'starting' | 'recording' | 'asking';

function formatDuration(durationMillis: number) {
  const seconds = Math.floor(durationMillis / 1_000);
  return `00:${String(seconds).padStart(2, '0')}`;
}

export function AskScreen({ isActive }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<AskPhase>('idle');
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heldRef = useRef(false);
  const recordingRef = useRef(false);
  const stopInProgressRef = useRef(false);

  const finishRecording = useCallback(async () => {
    if (!recordingRef.current || stopInProgressRef.current) {
      return;
    }
    stopInProgressRef.current = true;
    recordingRef.current = false;
    setError(null);
    try {
      await recorder.stop();
      const uri = recorder.uri ?? recorder.getStatus().url;
      if (!uri) {
        throw new Error('The recorder did not produce an audio file.');
      }
      setPhase('asking');
      setResult(await askWithAudio(uri));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not ask this question.');
    } finally {
      stopInProgressRef.current = false;
      setPhase('idle');
    }
  }, [recorder]);

  const beginRecording = useCallback(async () => {
    if (!isActive || phase === 'asking' || recordingRef.current) {
      return;
    }
    heldRef.current = true;
    setError(null);
    setPhase('starting');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Microphone access is required to ask by voice.');
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!heldRef.current) {
        setPhase('idle');
        return;
      }
      recorder.record();
      recordingRef.current = true;
      setResult(null);
      setPhase('recording');
    } catch (caught) {
      heldRef.current = false;
      recordingRef.current = false;
      setPhase('idle');
      setError(caught instanceof Error ? caught.message : 'Could not start the microphone.');
    }
  }, [isActive, phase, recorder]);

  const releaseRecording = useCallback(() => {
    heldRef.current = false;
    void finishRecording();
  }, [finishRecording]);

  useEffect(() => {
    if (!isActive && recordingRef.current) {
      heldRef.current = false;
      void finishRecording();
    }
  }, [finishRecording, isActive]);

  const recording = phase === 'recording';
  const asking = phase === 'asking';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>OPERATOR ASSIST</Text>
          <Text style={styles.title}>Ask SmartOperator</Text>
        </View>
        <View style={styles.machineBadge}>
          <View style={styles.machineDot} />
          <Text style={styles.machineText}>CNC-042</Text>
        </View>
      </View>

      <Text style={styles.intro}>
        Hold while you speak. Release to search approved plant knowledge.
      </Text>

      <View style={styles.talkArea}>
        <Pressable
          accessibilityHint="Hold while speaking and release to send"
          accessibilityLabel="Push to talk"
          accessibilityRole="button"
          disabled={asking}
          onPressIn={() => void beginRecording()}
          onPressOut={releaseRecording}
          style={({ pressed }) => [
            styles.talkButtonOuter,
            (pressed || recording) && styles.talkButtonOuterActive,
            asking && styles.talkButtonDisabled,
          ]}
        >
          <View style={[styles.talkButton, recording && styles.talkButtonActive]}>
            {asking ? (
              <ActivityIndicator color="#FFFFFF" size="large" />
            ) : (
              <>
                <View style={[styles.micStem, recording && styles.micStemActive]} />
                <View style={[styles.micBase, recording && styles.micBaseActive]} />
                <Text style={styles.talkButtonLabel}>{recording ? 'LISTENING' : 'HOLD'}</Text>
              </>
            )}
          </View>
        </Pressable>
        <Text style={[styles.talkStatus, recording && styles.talkStatusActive]}>
          {recording
            ? `${formatDuration(recorderState.durationMillis)} · Release to ask`
            : phase === 'starting'
              ? 'Opening microphone…'
              : asking
                ? 'Transcribing and checking approved knowledge…'
                : 'Push and hold to talk'}
        </Text>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text selectable style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {result ? (
        <View style={styles.resultArea}>
          <View style={styles.questionCard}>
            <Text style={styles.sectionLabel}>TRANSCRIBED QUESTION</Text>
            <Text selectable style={styles.question}>“{result.question}”</Text>
          </View>

          <View style={styles.answerCard}>
            <Text style={styles.sectionLabel}>APPROVED GUIDANCE</Text>
            <Text selectable style={styles.answer}>{result.answer}</Text>

            <View style={styles.sourceHeader}>
              <Text style={styles.sectionLabel}>SOURCES USED</Text>
              <Text style={styles.sourceCount}>{result.sources.length}</Text>
            </View>
            <View style={styles.sourceRow}>
              {result.sources.map((source) => (
                <View
                  accessibilityLabel={`${source.id}: ${source.label}`}
                  key={`${source.type}-${source.id}`}
                  style={[
                    styles.sourceChip,
                    source.type === 'capture' && styles.captureChip,
                  ]}
                >
                  <Text
                    style={[
                      styles.sourceId,
                      source.type === 'capture' && styles.captureSourceId,
                    ]}
                  >
                    {source.id}
                  </Text>
                  <Text numberOfLines={2} style={styles.sourceLabel}>{source.label}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  answer: {
    color: colors.ink,
    fontSize: 19,
    lineHeight: 29,
    marginTop: 14,
  },
  answerCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 22,
    borderWidth: 1,
    padding: 20,
  },
  captureChip: {
    backgroundColor: '#FFF0E9',
    borderColor: '#EBA58F',
  },
  captureSourceId: {
    color: '#9F351D',
  },
  container: {
    flexGrow: 1,
    paddingBottom: 32,
    paddingHorizontal: 20,
    paddingTop: 26,
  },
  errorCard: {
    backgroundColor: '#FDEBE6',
    borderColor: '#E5A08E',
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 18,
    padding: 14,
  },
  errorText: {
    color: '#8B2F1A',
    fontSize: 14,
    lineHeight: 20,
  },
  eyebrow: {
    color: colors.signal,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  intro: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    maxWidth: 330,
  },
  machineBadge: {
    alignItems: 'center',
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  machineDot: {
    backgroundColor: '#247A51',
    borderRadius: 999,
    height: 7,
    marginRight: 7,
    width: 7,
  },
  machineText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  micBase: {
    borderBottomWidth: 3,
    borderColor: '#FFFFFF',
    borderLeftWidth: 3,
    borderRadius: 9,
    borderRightWidth: 3,
    height: 16,
    marginBottom: 10,
    marginTop: -8,
    width: 30,
  },
  micBaseActive: {
    borderColor: '#7D2918',
  },
  micStem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    height: 34,
    width: 18,
  },
  micStemActive: {
    backgroundColor: '#7D2918',
  },
  question: {
    color: colors.ink,
    fontSize: 16,
    fontStyle: 'italic',
    lineHeight: 24,
    marginTop: 10,
  },
  questionCard: {
    backgroundColor: '#EAE7DE',
    borderRadius: 16,
    padding: 16,
  },
  resultArea: {
    rowGap: 12,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  sourceChip: {
    backgroundColor: '#EEF2EF',
    borderColor: '#B9C7BF',
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 126,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  sourceCount: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  sourceHeader: {
    alignItems: 'center',
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 22,
    paddingTop: 17,
  },
  sourceId: {
    color: '#1D6345',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  sourceLabel: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
    maxWidth: 170,
  },
  sourceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: 12,
  },
  talkArea: {
    alignItems: 'center',
    marginVertical: 28,
  },
  talkButton: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 999,
    height: 138,
    justifyContent: 'center',
    width: 138,
  },
  talkButtonActive: {
    backgroundColor: '#FFB29A',
  },
  talkButtonDisabled: {
    opacity: 0.82,
  },
  talkButtonLabel: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  talkButtonOuter: {
    alignItems: 'center',
    borderColor: '#D8D3C7',
    borderRadius: 999,
    borderWidth: 10,
    height: 158,
    justifyContent: 'center',
    width: 158,
  },
  talkButtonOuterActive: {
    borderColor: '#F6D2C6',
    transform: [{ scale: 1.03 }],
  },
  talkStatus: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 12,
  },
  talkStatusActive: {
    color: '#9F351D',
  },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.6,
    marginTop: 4,
  },
});
