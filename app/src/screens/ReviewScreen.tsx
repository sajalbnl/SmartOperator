import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  approveProcedure,
  listPendingProcedures,
  rejectProcedure,
  type ProcedureDraft,
} from '../queue/api';
import { colors } from '../theme';

type Props = {
  isActive: boolean;
};

function displayCaptureId(captureId: string) {
  return `CAP-${captureId}`;
}

export function ReviewScreen({ isActive }: Props) {
  const [drafts, setDrafts] = useState<ProcedureDraft[]>([]);
  const [selected, setSelected] = useState<ProcedureDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<'approving' | 'rejecting' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<'approved' | 'rejected' | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const closeDetail = useCallback(() => {
    setSelected(null);
    setSuccess(null);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await listPendingProcedures();
      setDrafts(result.procedures);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load drafts for review.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive || selected) {
      return;
    }
    setLoading(true);
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [isActive, refresh, selected]);

  const approve = useCallback(async () => {
    if (!selected || decision || selected.reviewStatus !== 'pending') {
      return;
    }
    setDecision('approving');
    setError(null);
    try {
      const result = await approveProcedure(selected.id);
      setSelected(result.procedure);
      setDrafts((current) => current.filter((draft) => draft.id !== selected.id));
      setSuccess('approved');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not approve this procedure.');
    } finally {
      setDecision(null);
    }
  }, [decision, selected]);

  const reject = useCallback(async () => {
    if (!selected || decision || selected.reviewStatus !== 'pending') {
      return;
    }
    setDecision('rejecting');
    setError(null);
    try {
      const result = await rejectProcedure(selected.id);
      setSelected(result.procedure);
      setDrafts((current) => current.filter((draft) => draft.id !== selected.id));
      setSuccess('rejected');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reject this procedure.');
    } finally {
      setDecision(null);
    }
  }, [decision, selected]);

  const confirmReject = useCallback(() => {
    if (!selected || decision || selected.reviewStatus !== 'pending') {
      return;
    }
    Alert.alert(
      'Reject this draft?',
      'It will not enter the knowledge base. The transcript and draft will be retained for audit.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reject draft', style: 'destructive', onPress: () => void reject() },
      ],
    );
  }, [decision, reject, selected]);

  useEffect(() => {
    if (!isActive || !selected) {
      return;
    }
    const frame = requestAnimationFrame(() => scrollRef.current?.scrollTo({ animated: false, y: 0 }));
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeDetail();
      return true;
    });
    return () => {
      cancelAnimationFrame(frame);
      subscription.remove();
    };
  }, [closeDetail, isActive, selected]);

  if (selected) {
    return (
      <ScrollView ref={scrollRef} contentContainerStyle={styles.container}>
        <Pressable
          accessibilityRole="button"
          onPress={closeDetail}
          style={({ pressed }) => [styles.backControl, pressed && styles.pressed]}
        >
          <Text style={styles.backLabel}>← Drafts</Text>
        </Pressable>

        <View style={styles.detailHeader}>
          <Text style={styles.eyebrow}>HUMAN REVIEW · {displayCaptureId(selected.captureId)}</Text>
          <Text style={styles.detailTitle}>{selected.title}</Text>
          <Text style={styles.machine}>{selected.machineId}</Text>
        </View>

        <View style={styles.transcriptCard}>
          <Text style={styles.sectionLabel}>EXPERT TRANSCRIPT</Text>
          <Text selectable style={styles.transcript}>
            “{selected.transcript}”
          </Text>
        </View>

        <View style={styles.procedureCard}>
          <Text style={styles.sectionLabel}>DRAFT PROCEDURE</Text>
          <Text style={styles.procedureTitle}>{selected.title}</Text>

          <Text style={styles.subheading}>Steps</Text>
          {selected.steps.map((step, index) => (
            <View key={`${index}-${step}`} style={styles.stepRow}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{index + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}

          <Text style={styles.subheading}>Tools</Text>
          {selected.tools.length ? (
            <View style={styles.chipRow}>
              {selected.tools.map((tool) => (
                <View key={tool} style={styles.toolChip}>
                  <Text style={styles.toolChipText}>{tool}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.noneText}>No tools specified by the expert.</Text>
          )}

          <Text style={styles.subheading}>Safety</Text>
          {selected.safety.length ? (
            selected.safety.map((item) => (
              <View key={item} style={styles.safetyCallout}>
                <Text style={styles.safetyMark}>!</Text>
                <Text style={styles.safetyText}>{item}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.noneText}>No safety callouts specified by the expert.</Text>
          )}
        </View>

        {error ? <Text selectable style={styles.error}>{error}</Text> : null}
        {success ? (
          <View style={[styles.successCard, success === 'rejected' && styles.rejectedCard]}>
            <Text style={[styles.successTitle, success === 'rejected' && styles.rejectedTitle]}>
              {success === 'approved' ? 'Added to the knowledge base' : 'Draft rejected'}
            </Text>
            <Text style={styles.successCopy}>
              {success === 'approved'
                ? 'This approved procedure can now be used as trusted captured knowledge.'
                : 'This draft will not enter the knowledge base. It remains recorded for audit.'}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={decision !== null || selected.reviewStatus !== 'pending'}
          onPress={() => void approve()}
          style={({ pressed }) => [
            styles.approveButton,
            pressed && styles.pressed,
            (decision !== null || selected.reviewStatus !== 'pending') && styles.approveButtonDone,
          ]}
        >
          {decision === 'approving' ? <ActivityIndicator color="#FFFFFF" /> : null}
          <Text style={styles.approveButtonLabel}>
            {selected.reviewStatus === 'approved'
              ? 'Approved and added'
              : selected.reviewStatus === 'rejected'
                ? 'Draft rejected'
                : decision === 'approving'
                ? 'Approving…'
                : 'Approve and add to knowledge base'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={decision !== null || selected.reviewStatus !== 'pending'}
          onPress={confirmReject}
          style={({ pressed }) => [
            styles.rejectButton,
            pressed && styles.pressed,
            (decision !== null || selected.reviewStatus !== 'pending') && styles.rejectButtonDone,
          ]}
        >
          {decision === 'rejecting' ? <ActivityIndicator color="#9F351D" /> : null}
          <Text style={styles.rejectButtonLabel}>
            {selected.reviewStatus === 'rejected'
              ? 'Rejected'
              : decision === 'rejecting'
                ? 'Rejecting…'
                : 'Reject draft'}
          </Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.listHeader}>
        <Text style={styles.eyebrow}>APPROVAL GATE</Text>
        <Text style={styles.listTitle}>Review captured knowledge</Text>
        <Text style={styles.listCopy}>
          Nothing enters the knowledge base until a person reviews it. Rejected drafts stay
          recorded for audit.
        </Text>
      </View>

      {error ? <Text selectable style={styles.error}>{error}</Text> : null}
      {loading && drafts.length === 0 ? (
        <View style={styles.loadingCard}>
          <ActivityIndicator color={colors.signal} />
          <Text style={styles.loadingText}>Looking for structured drafts…</Text>
        </View>
      ) : drafts.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No drafts waiting</Text>
          <Text style={styles.emptyCopy}>
            Uploaded captures will appear here after transcription and structuring.
          </Text>
        </View>
      ) : (
        drafts.map((draft) => (
          <Pressable
            accessibilityRole="button"
            key={draft.id}
            onPress={() => {
              setSelected(draft);
              setSuccess(null);
              setError(null);
            }}
            style={({ pressed }) => [styles.draftCard, pressed && styles.pressed]}
          >
            <View style={styles.draftTopRow}>
              <Text style={styles.captureId}>{displayCaptureId(draft.captureId)}</Text>
              <Text style={styles.pendingBadge}>NEEDS REVIEW</Text>
            </View>
            <Text style={styles.draftTitle}>{draft.title}</Text>
            <Text numberOfLines={2} style={styles.draftTranscript}>
              “{draft.transcript}”
            </Text>
            <Text style={styles.openLabel}>Open draft →</Text>
          </Pressable>
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
  eyebrow: {
    color: colors.signal,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  listHeader: {
    marginBottom: 22,
    marginTop: 8,
  },
  listTitle: {
    color: colors.ink,
    fontSize: 29,
    fontWeight: '900',
    lineHeight: 34,
    marginTop: 6,
  },
  listCopy: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 9,
  },
  draftCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 13,
    padding: 17,
  },
  pressed: {
    opacity: 0.68,
  },
  draftTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  captureId: {
    color: colors.ink,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 13,
    fontWeight: '900',
  },
  pendingBadge: {
    backgroundColor: '#FCE5DE',
    borderRadius: 999,
    color: '#9F351D',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.7,
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  draftTitle: {
    color: colors.ink,
    fontSize: 19,
    fontWeight: '800',
    lineHeight: 25,
    marginTop: 13,
  },
  draftTranscript: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 20,
    marginTop: 8,
  },
  openLabel: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: '900',
    marginTop: 14,
  },
  loadingCard: {
    alignItems: 'center',
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: 14,
    marginLeft: 12,
  },
  emptyCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 22,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  emptyCopy: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 7,
  },
  backControl: {
    alignSelf: 'flex-start',
    paddingBottom: 12,
    paddingRight: 18,
    paddingTop: 2,
  },
  backLabel: {
    color: colors.signal,
    fontSize: 14,
    fontWeight: '800',
  },
  detailHeader: {
    marginBottom: 18,
  },
  detailTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '900',
    lineHeight: 34,
    marginTop: 7,
  },
  machine: {
    color: colors.textMuted,
    fontFamily: Platform.select({ android: 'monospace' }),
    fontSize: 12,
    fontWeight: '700',
    marginTop: 8,
  },
  transcriptCard: {
    backgroundColor: '#E9E5D9',
    borderRadius: 18,
    padding: 18,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  transcript: {
    color: colors.ink,
    fontSize: 16,
    fontStyle: 'italic',
    lineHeight: 25,
    marginTop: 11,
  },
  procedureCard: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,
  },
  procedureTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 28,
    marginTop: 8,
  },
  subheading: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 10,
    marginTop: 22,
  },
  stepRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    marginBottom: 13,
  },
  stepNumber: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 999,
    height: 25,
    justifyContent: 'center',
    marginRight: 11,
    width: 25,
  },
  stepNumberText: {
    color: colors.panel,
    fontSize: 11,
    fontWeight: '900',
  },
  stepText: {
    color: colors.ink,
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  toolChip: {
    backgroundColor: '#E3E9E5',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  toolChipText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
  },
  noneText: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  safetyCallout: {
    backgroundColor: '#FFF0D7',
    borderColor: '#E7C78C',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 12,
  },
  safetyMark: {
    color: '#8A5B00',
    fontSize: 15,
    fontWeight: '900',
    marginRight: 10,
  },
  safetyText: {
    color: '#5F460F',
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  approveButton: {
    alignItems: 'center',
    backgroundColor: colors.signal,
    borderRadius: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 16,
    marginTop: 16,
    minHeight: 58,
    paddingHorizontal: 16,
  },
  approveButtonDone: {
    backgroundColor: '#247A51',
  },
  approveButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    marginLeft: 8,
    textAlign: 'center',
  },
  rejectButton: {
    alignItems: 'center',
    backgroundColor: '#FFF7F4',
    borderColor: '#C9563A',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 20,
    minHeight: 52,
    paddingHorizontal: 16,
  },
  rejectButtonDone: {
    opacity: 0.55,
  },
  rejectButtonLabel: {
    color: '#9F351D',
    fontSize: 14,
    fontWeight: '900',
    marginLeft: 8,
  },
  successCard: {
    backgroundColor: '#DCEFE4',
    borderColor: '#A8D1B8',
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 14,
    padding: 15,
  },
  successTitle: {
    color: '#195C3B',
    fontSize: 15,
    fontWeight: '900',
  },
  successCopy: {
    color: '#2C674A',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  rejectedCard: {
    backgroundColor: '#FCE5DE',
    borderColor: '#E1A493',
  },
  rejectedTitle: {
    color: '#8D2D19',
  },
  error: {
    color: '#A9321A',
    fontSize: 12,
    lineHeight: 18,
    marginVertical: 10,
  },
});
