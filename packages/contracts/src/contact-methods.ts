import { z } from "zod";
import { endpoint } from "./endpoint.ts";
import { ContactMethodDto } from "./conversations.ts";

const C = "/v1/workspaces/:workspaceId/contacts/:contactId";

/** The corrected value is validated and normalised on the server by kind (phone: Bangladeshi or +country code; email: the same rule as manual entry). */
export const CorrectContactMethodBody = z.object({ value: z.string().trim().min(3).max(254) });
export type CorrectContactMethodBody = z.infer<typeof CorrectContactMethodBody>;
export const ContactMethodList = z.object({ items: z.array(ContactMethodDto) });
export type ContactMethodList = z.infer<typeof ContactMethodList>;

export const contactMethodEndpoints = {
  listContactMethods: endpoint({ method: "GET", path: `${C}/methods`, response: ContactMethodList }),
  correctContactMethod: endpoint({ method: "PATCH", path: `${C}/methods/:methodId`, body: CorrectContactMethodBody, response: ContactMethodDto }),
  deleteContactMethod: endpoint({ method: "DELETE", path: `${C}/methods/:methodId`, response: z.undefined() }),
} as const;
