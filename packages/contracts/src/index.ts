import { z } from "zod";

export const MeResponse = z.object({ id: z.string(), email: z.string().email(), name: z.string() });
export type MeResponse = z.infer<typeof MeResponse>;
