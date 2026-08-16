import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

type Props = {
  name: 'Review' | 'Ask';
};

export function PlaceholderScreen({ name }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.copy}>Coming in a later phase.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: colors.ink,
    fontSize: 32,
    fontWeight: '800',
  },
  copy: {
    color: colors.textMuted,
    fontSize: 16,
    marginTop: 10,
  },
});

