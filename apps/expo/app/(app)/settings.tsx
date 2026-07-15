import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { useOnboarding } from "../_layout";
import { SettingsScreen } from "../../src/features/settings/screens/SettingsScreen";
import { supabase } from "../../src/lib/supabase/client";

export default function SettingsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUserEmail(data.user?.email ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const displayName =
    userEmail?.split("@")[0] ?? (state.isAnonymous ? "Guest" : "You");
  const appVersion = (Constants.expoConfig?.version as string | undefined) ?? "—";
  const buildNumber =
    (Constants.expoConfig?.runtimeVersion as string | undefined) ?? "—";

  const handleSignOut = () => {
    Alert.alert(
      "Sign out",
      "You'll need to verify your email again next time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            setIsSigningOut(true);
            await supabase.auth.signOut();
            setIsSigningOut(false);
            router.replace("/");
          },
        },
      ],
    );
  };

  return (
    <SettingsScreen
      appVersion={appVersion}
      buildNumber={buildNumber}
      displayName={displayName}
      isAnonymous={state.isAnonymous}
      isSigningOut={isSigningOut}
      notificationsEnabled={notificationsEnabled}
      onClose={() => router.back()}
      onEditProfile={() => router.push("/(app)/edit-profile")}
      onOpenNotifications={() => router.push("/(app)/notifications")}
      onOpenTeams={() => router.push("/(app)/teams")}
      onOpenWorkspaces={() => router.push("/(app)/workspaces")}
      onSignOut={handleSignOut}
      onToggleNotifications={setNotificationsEnabled}
      onUpgrade={() => router.push("/(app)/upgrade-account")}
      team={
        state.currentTeam
          ? {
              id: state.currentTeam.id,
              name: state.currentTeam.name,
              role: state.currentTeam.role ?? null,
            }
          : null
      }
      userEmail={userEmail}
    />
  );
}
