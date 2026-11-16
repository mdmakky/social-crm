import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { endpoints, type MeResponse, type WorkspaceSummary } from "@crm/contracts";
import { canDecideApprovals } from "@crm/core/approvals";
import { api } from "./api";
import { ApprovalsScreen } from "./approvals-screen";

/** Signed-in home: pick a workspace, then open Approvals. No navigation library yet, so screens switch with state. */
export function SignedIn({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [open, setOpen] = useState<WorkspaceSummary | null>(null);

  useEffect(() => {
    void api.call(endpoints.listWorkspaces).then((r) => (r.ok ? setWorkspaces(r.data) : setError(r.error.message)));
  }, []);

  async function loadMe() {
    const res = await api.call(endpoints.me);
    if (!res.ok) return setError(`${res.error.code}: ${res.error.message}`);
    setMe(res.data);
  }

  if (open) return <ApprovalsScreen workspaceId={open.id} role={open.role} onBack={() => setOpen(null)} />;

  return (
    <View style={styles.box}>
      <Text testID="signed-in">Signed in as {email}</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={loadMe}><Text style={styles.buttonText}>Call /v1/me</Text></Pressable>
      {me && <Text testID="me">API says: {me.email}</Text>}
      <Text style={styles.heading}>Workspaces</Text>
      {workspaces === null && !error && <ActivityIndicator />}
      {workspaces?.length === 0 && <Text>You are not in a workspace yet. Create one in the web app.</Text>}
      {workspaces?.map((w) => (
        <View key={w.id} style={styles.ws}>
          <Text style={styles.wsName}>{w.name} ({w.role})</Text>
          {canDecideApprovals(w.role) ? (
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => setOpen(w)}><Text style={styles.buttonText}>Approvals</Text></Pressable>
          ) : (
            <Text style={styles.muted}>Approvals are for owners and admins.</Text>
          )}
        </View>
      ))}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Pressable accessibilityRole="button" style={styles.button} onPress={onSignOut}><Text style={styles.buttonText}>Sign out</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12 },
  heading: { fontSize: 18, fontWeight: "600" },
  ws: { gap: 8 },
  wsName: { fontWeight: "600" },
  muted: { color: "#6b7280" },
  error: { color: "#b91c1c" },
  button: { backgroundColor: "#1f2937", borderRadius: 8, padding: 14, minHeight: 48, justifyContent: "center", alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600" },
});
