// Metro config tuned for our pnpm monorepo layout.
//
// `@teamclaw/app` declares react@^19.2.6 in its own dependencies. pnpm
// honours that by symlinking a second React copy into the workspace.
// When `apps/expo` imports from `@teamclaw/app/proto/...`, Metro walks
// `@teamclaw/app`'s dep graph and resolves a different React copy than
// the one `apps/expo` itself uses (react@19.0.0). Two Reacts in the same
// bundle break hooks at runtime ("Invalid hook call" / "Cannot read
// property 'useMemo' of null").
//
// `extraNodeModules` alone isn't enough because pnpm symlinks resolve
// before Metro's resolver consults it. We need `resolveRequest` to
// intercept every `react` / `react-native` request and force it back to
// apps/expo's copy regardless of which dep graph asked.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Force-singleton packages: every import resolves to the copy installed
// at apps/expo/node_modules/<name>, never a transitive copy.
// Only force-singleton the packages we actually keep at apps/expo/node_modules.
// Don't include transitive deps like `scheduler` — pnpm doesn't symlink those
// at this level, so a redirect would resolve to a missing path.
const SINGLETON_PACKAGES = ["react", "react-native"];
const singletonPaths = Object.fromEntries(
  SINGLETON_PACKAGES.map((name) => [
    name,
    path.resolve(projectRoot, "node_modules", name),
  ]),
);

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Match a bare package import for one of our singletons, e.g. `react`
  // or `react/jsx-runtime`. Sub-paths must still resolve inside the
  // singleton directory.
  for (const pkg of SINGLETON_PACKAGES) {
    if (moduleName === pkg || moduleName.startsWith(pkg + "/")) {
      const rest = moduleName.slice(pkg.length);
      return context.resolveRequest(context, singletonPaths[pkg] + rest, platform);
    }
  }
  return upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
