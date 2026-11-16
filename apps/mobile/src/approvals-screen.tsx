import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { endpoints, type AutomationRunDto } from "@crm/contracts";
import { canDecideApprovals, summarizeApprovalActions, triggerLabel } from "@crm/core/approvals";
import type { Role } from "@crm/core/permissions";
import { radius, semantic, space } from "@crm/design-tokens";
import { api } from "./api";

const c = semantic.light;
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready" };

/** Automation runs waiting for approval. Owner/admin only (the API enforces it too); the kill switch is shown read-only. */
export function ApprovalsScreen({ workspaceId, role, onBack }: { workspaceId: string; role: Role; onBack: () => void }) {
  const params = { workspaceId };
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [runs, setRuns] = useState<AutomationRunDto[]>([]);
  const [killSwitch, setKillSwitch] = useState(false);
  const [members, setMembers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const allowed = canDecideApprovals(role);

  const refresh = useCallback(async () => {
    const [r, s, m] = await Promise.all([api.call(endpoints.listAutomationRuns, { params, query: { status: "awaiting_approval", limit: 50 } }), api.call(endpoints.getAutomationSettings, { params }), api.call(endpoints.listMembers, { params })]);
    if (!r.ok) return setLoad({ state: "error", message: r.error.message });
    setRuns(r.data.items);
    if (s.ok) setKillSwitch(s.data.killSwitch);
    if (m.ok) setMembers(Object.fromEntries(m.data.map((x) => [x.userId, x.name])));
    setLoad({ state: "ready" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    // refresh() only sets state after awaiting the network; the rule cannot see through the async call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (allowed) void refresh();
  }, [allowed, refresh]);

  async function decide(run: AutomationRunDto, approve: boolean) {
    setBusy(run.id);
    setNotice(null);
    const res = await api.call(approve ? endpoints.approveAutomationRun : endpoints.rejectAutomationRun, { params: { ...params, runId: run.id } });
    setNotice(res.ok ? (approve ? `Approved "${run.ruleName}"` : `Rejected "${run.ruleName}"`) : res.error.message);
    await refresh(); // the server decides; always reload instead of guessing the new state
    setBusy(null);
  }

  const confirm = (run: AutomationRunDto, approve: boolean) =>
    Alert.alert(approve ? "Approve this run?" : "Reject this run?", `${run.ruleName}\n${summarizeApprovalActions(run.actions, (id) => members[id])}`, [
      { text: "Cancel", style: "cancel" },
      { text: approve ? "Approve" : "Reject", style: approve ? "default" : "destructive", onPress: () => void decide(run, approve) },
    ]);

  const header = (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}><Text style={styles.link}>Back</Text></Pressable>
      <Text accessibilityRole="header" style={styles.title}>Approvals</Text>
    </View>
  );

  if (!allowed) return <View style={styles.screen}>{header}<Text style={styles.muted}>Only owners and admins can review automation approvals.</Text></View>;
  if (load.state === "loading") return <View style={styles.screen}>{header}<ActivityIndicator accessibilityLabel="Loading approvals" /></View>;
  if (load.state === "error")
    return (
      <View style={styles.screen}>
        {header}
        <Text accessibilityRole="alert" style={styles.error}>{load.message}</Text>
        <Pressable accessibilityRole="button" style={styles.btn} onPress={() => { setLoad({ state: "loading" }); void refresh(); }}><Text style={styles.btnText}>Try again</Text></Pressable>
      </View>
    );

  return (
    <View style={styles.screen}>
      {header}
      {killSwitch && <Text accessibilityRole="alert" style={styles.banner}>Automations are paused for this workspace. Runs cannot be approved until it is resumed in the web app.</Text>}
      {notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      <FlatList
        data={runs}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); }} />}
        ListEmptyComponent={<Text style={styles.muted}>Nothing waiting for approval.</Text>}
        contentContainerStyle={{ gap: space[3] }}
        renderItem={({ item: r }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{r.ruleName}</Text>
            <Text style={styles.muted}>{triggerLabel(r.triggerType)} · {new Date(r.createdAt).toLocaleString()}</Text>
            <Text style={styles.body}>{summarizeApprovalActions(r.actions, (id) => members[id])}</Text>
            <View style={styles.row}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Approve run of ${r.ruleName}`} disabled={busy !== null || killSwitch} style={[styles.btn, (busy !== null || killSwitch) && styles.disabled]} onPress={() => confirm(r, true)}>
                <Text style={styles.btnText}>{busy === r.id ? "Working…" : "Approve"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Reject run of ${r.ruleName}`} disabled={busy !== null} style={[styles.btnAlt, busy !== null && styles.disabled]} onPress={() => confirm(r, false)}>
                <Text style={styles.btnAltText}>Reject</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c["bg-canvas"], padding: space[4], paddingTop: space[9], gap: space[3] },
  header: { flexDirection: "row", alignItems: "center", gap: space[3] },
  back: { minHeight: 44, justifyContent: "center" },
  link: { color: c["accent-fg"], fontWeight: "600" },
  title: { fontSize: 22, fontWeight: "600", color: c.fg },
  muted: { color: c["fg-muted"] },
  body: { color: c.fg },
  error: { color: c["danger-fg"] },
  banner: { backgroundColor: c["warning-bg"], color: c["warning-fg"], padding: space[3], borderRadius: radius.md },
  notice: { backgroundColor: c["accent-subtle"], color: c["accent-fg"], padding: space[3], borderRadius: radius.md },
  card: { backgroundColor: c["bg-surface"], borderRadius: radius.lg, padding: space[4], gap: space[2], borderWidth: 1, borderColor: c["line-card"] },
  cardTitle: { fontWeight: "600", fontSize: 16, color: c.fg },
  row: { flexDirection: "row", gap: space[2] },
  btn: { backgroundColor: c.accent, borderRadius: radius.md, minHeight: 44, paddingHorizontal: space[4], justifyContent: "center", alignItems: "center" },
  btnText: { color: c["on-accent"], fontWeight: "600" },
  btnAlt: { borderRadius: radius.md, minHeight: 44, paddingHorizontal: space[4], justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: c["line-strong"] },
  btnAltText: { color: c.fg, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});
