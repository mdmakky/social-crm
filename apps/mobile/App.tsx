import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { endpoints, type MeResponse } from "@crm/contracts";
import { createApiClient } from "@crm/api-client";
import { API_URL, authClient } from "./src/auth-client";

// Shared typed client. The Expo auth client keeps the session in SecureStore; its cookie is sent as a manual header.
const api = createApiClient({ baseUrl: API_URL, auth: { mode: "cookie" }, credentials: "omit", headers: async () => ({ Cookie: await authClient.getCookie() }) });

export default function App() {
  const { data: session, isPending } = authClient.useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (res.error) setError(res.error.message ?? "Request failed");
    setBusy(false);
  }

  async function loadMe() {
    const res = await api.call(endpoints.me);
    if (!res.ok) return setError(`${res.error.code}: ${res.error.message}`);
    setMe(res.data);
  }

  if (isPending) return <ActivityIndicator style={styles.center} />;

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Social CRM</Text>
      {session ? (
        <>
          <Text testID="signed-in">Signed in as {session.user.email}</Text>
          <Pressable accessibilityRole="button" style={styles.button} onPress={loadMe}>
            <Text style={styles.buttonText}>Call /v1/me</Text>
          </Pressable>
          {me && <Text testID="me">API says: {me.email}</Text>}
          <Pressable accessibilityRole="button" style={styles.button} onPress={() => run(() => authClient.signOut().then(() => ({})))}>
            <Text style={styles.buttonText}>Sign out</Text>
          </Pressable>
        </>
      ) : (
        <>
          <TextInput testID="email" style={styles.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
          <TextInput testID="password" style={styles.input} placeholder="Password (10+ characters)" secureTextEntry value={password} onChangeText={setPassword} />
          <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => run(() => authClient.signIn.email({ email, password }))}>
            <Text style={styles.buttonText}>Sign in</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} style={styles.buttonAlt} onPress={() => run(() => authClient.signUp.email({ email, password, name: email.split("@")[0] ?? "User" }))}>
            <Text style={styles.buttonText}>Create account</Text>
          </Pressable>
        </>
      )}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#c9ccd1", borderRadius: 8, padding: 12, minHeight: 48 },
  button: { backgroundColor: "#1f2937", borderRadius: 8, padding: 14, minHeight: 48, justifyContent: "center", alignItems: "center" },
  buttonAlt: { backgroundColor: "#4b5563", borderRadius: 8, padding: 14, minHeight: 48, justifyContent: "center", alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#b91c1c" },
});
