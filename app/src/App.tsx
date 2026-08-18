import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { CaptureScreen } from './screens/CaptureScreen';
import { AskScreen } from './screens/AskScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { colors } from './theme';
import { durableUploader } from './queue/uploader';

type Tab = 'Capture' | 'Review' | 'Ask';

const tabs: Tab[] = ['Capture', 'Review', 'Ask'];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('Ask');

  useEffect(() => {
    void durableUploader.start();
    return () => durableUploader.stop();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View
        accessibilityElementsHidden={activeTab !== 'Capture'}
        importantForAccessibility={activeTab === 'Capture' ? 'auto' : 'no-hide-descendants'}
        style={[styles.content, activeTab !== 'Capture' && styles.hidden]}
      >
        <CaptureScreen />
      </View>
      <View
        accessibilityElementsHidden={activeTab !== 'Review'}
        importantForAccessibility={activeTab === 'Review' ? 'auto' : 'no-hide-descendants'}
        style={[styles.content, activeTab !== 'Review' && styles.hidden]}
      >
        <ReviewScreen isActive={activeTab === 'Review'} />
      </View>
      <View
        accessibilityElementsHidden={activeTab !== 'Ask'}
        importantForAccessibility={activeTab === 'Ask' ? 'auto' : 'no-hide-descendants'}
        style={[styles.content, activeTab !== 'Ask' && styles.hidden]}
      >
        <AskScreen isActive={activeTab === 'Ask'} />
      </View>
      <View accessibilityRole="tablist" style={styles.tabBar}>
        {tabs.map((tab) => {
          const selected = tab === activeTab;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
            >
              <View style={[styles.tabMarker, selected && styles.tabMarkerActive]} />
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>{tab}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
    // Android edge-to-edge layouts do not receive a top inset from the
    // core SafeAreaView. Keep every screen header below the system status bar.
    paddingTop: Platform.OS === 'android' ? NativeStatusBar.currentHeight ?? 0 : 0,
  },
  content: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
  tabBar: {
    backgroundColor: colors.panel,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 72,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    rowGap: 8,
  },
  tabPressed: {
    opacity: 0.68,
  },
  tabMarker: {
    backgroundColor: 'transparent',
    borderRadius: 999,
    height: 4,
    width: 28,
  },
  tabMarkerActive: {
    backgroundColor: colors.signal,
  },
  tabLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: colors.ink,
  },
});
