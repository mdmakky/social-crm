import { contactsProvider } from "./contacts.ts";
import { leadsProvider } from "./leads.ts";
import type { SearchProvider } from "./types.ts";

/** Add a provider here only when its entity exists. Nothing else (endpoint, UI) changes. */
export const defaultProviders: SearchProvider[] = [contactsProvider, leadsProvider];
