import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";

// 10.0.2.2 is the Android emulator's alias for the host machine's localhost.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:8787";

export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [expoClient({ scheme: "crm", storagePrefix: "crm", storage: SecureStore })],
});
