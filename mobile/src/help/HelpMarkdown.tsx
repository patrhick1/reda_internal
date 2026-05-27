import React from 'react';
import Markdown from 'react-native-markdown-display';
import { colors, fonts } from '@/lib/theme';

/**
 * Centralised markdown style map. Every Reda help section renders through
 * here so the look stays consistent. Adjust this file (not the screens) to
 * change spacing, headings, or list bullets.
 */
const styles = {
  body: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 21,
  },
  paragraph: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 21,
    marginTop: 0,
    marginBottom: 10,
  },
  strong: { fontFamily: fonts.bold },
  em: { fontFamily: fonts.medium, fontStyle: 'italic' as const },
  heading2: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.black,
    letterSpacing: -0.2,
    marginTop: 8,
    marginBottom: 6,
  },
  heading3: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.black,
    letterSpacing: -0.1,
    marginTop: 6,
    marginBottom: 4,
  },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { marginBottom: 4 },
  bullet_list_icon: {
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    marginLeft: 0,
    marginRight: 6,
    lineHeight: 21,
  },
  ordered_list_icon: {
    fontFamily: fonts.semibold,
    color: colors.textSecondary,
    marginRight: 6,
    lineHeight: 21,
  },
  code_inline: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.red,
    backgroundColor: colors.surface,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  code_block: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    marginBottom: 8,
  },
  link: { color: colors.red, fontFamily: fonts.medium },
  hr: {
    backgroundColor: colors.border,
    height: 1,
    marginVertical: 10,
  },
};

export function HelpMarkdown({ children }: { children: string }) {
  return <Markdown style={styles}>{children}</Markdown>;
}
