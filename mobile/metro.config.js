// Metro config — Expo SDK 54 supports tsconfig path aliases natively when
// `experimentalImportSupport` and `unstable_enablePackageExports` are on the default.
// This file exists so future Metro tweaks have a home; defaults are fine for now.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
