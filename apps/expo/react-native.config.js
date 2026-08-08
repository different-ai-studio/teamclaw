module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: 'import expo.modules.ExpoModulesPackage;',
          packageInstance: 'new ExpoModulesPackage()',
        },
      },
    },
    // `react-native-reanimated@4.3.1` reaches us only transitively, through
    // `react-native-drawer-layout` (a react-navigation dependency). Nothing in
    // this app imports it and no drawer navigator is mounted, but autolinking
    // still hands its podspec to CocoaPods — and that podspec hard-asserts a
    // React Native version (`peerDependencies: "0.81 - 0.85"`) that 0.86.0 does
    // not satisfy. The assertion aborts `pod install`, so the native build
    // could not run at all.
    //
    // Excluding it from autolinking skips the podspec. If a drawer navigator or
    // any direct reanimated use ever lands here, remove this and upgrade
    // reanimated to a release that supports the pinned React Native instead.
    'react-native-reanimated': {
      platforms: {
        ios: null,
        android: null,
      },
    },
    // Reanimated's companion package, pulled in by the same transitive path and
    // failing the same way — its podspec asserts a React Native version too.
    // Excluding reanimated alone just moves the error here.
    'react-native-worklets': {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
