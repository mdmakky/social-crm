import { createApiClient } from "@crm/api-client";
import { API_URL, authClient } from "./auth-client";

// Shared typed client. The Expo auth client keeps the session in SecureStore; its cookie is sent as a manual header.
export const api = createApiClient({ baseUrl: API_URL, auth: { mode: "cookie" }, credentials: "omit", headers: async () => ({ Cookie: await authClient.getCookie() }) });
