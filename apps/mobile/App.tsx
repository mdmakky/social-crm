import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { authClient } from "./src/auth-client";
import { SignedIn } from "./src/signed-in";

export default function App() {
  const { data: session, isPending } = authClient.useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (res.error) setError(res.error.message ?? "Request failed");
    setBusy(false);
  }

  if (isPending) return <ActivityIndicator style={styles.center} />;

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Social CRM</Text>
      {session ? (
        <SignedIn email={session.user.email} onSignOut={() => void run(() => authClient.signOut().then(() => ({})))} />
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
