"use client";
import * as React from "react";

/** Workspace preferences from Settings > General that screens read: currency, clock, first day of the week, time zone. */
export type WorkspacePrefs = { timeZone: string; currency: string; timeFormat: "12h" | "24h"; weekStart: "sat" | "sun" | "mon" };
export const DEFAULT_PREFS: WorkspacePrefs = { timeZone: "UTC", currency: "USD", timeFormat: "12h", weekStart: "sun" };
const Ctx = React.createContext<WorkspacePrefs>(DEFAULT_PREFS);
export const WorkspacePrefsProvider = ({ value, children }: { value: WorkspacePrefs; children: React.ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useWorkspacePrefs = () => React.useContext(Ctx);
