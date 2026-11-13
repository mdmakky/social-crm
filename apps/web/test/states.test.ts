import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState, ErrorState } from "@/components/ui/states";
import Loading from "@/app/w/[workspaceId]/loading";
import MembersLoading from "@/app/w/[workspaceId]/members/loading";
import SettingsLoading from "@/app/w/[workspaceId]/settings/loading";
import WorkspaceError from "@/app/w/[workspaceId]/error";
import { AuditList } from "@/app/w/[workspaceId]/audit-log/audit-list";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("loading states are announced and shaped per route", () => {
  it.each([["home", Loading], ["members and audit", MembersLoading], ["settings", SettingsLoading]] as const)("%s skeleton has role=status and an accessible label", (_n, C) => {
    const m = html(createElement(C));
    expect(m).toContain('role="status"');
    expect(m).toContain("Loading");
    expect(m).toContain("skeleton");
  });
});

describe("error and empty states", () => {
  it("ErrorState is an alert with a retry control only when retry is possible", () => {
    expect(html(createElement(ErrorState, { title: "Nope", onRetry: () => {} }))).toMatch(/role="alert"[\s\S]*Try again/);
    expect(html(createElement(ErrorState, { title: "Nope" }))).not.toContain("Try again");
  });
  it("the workspace error boundary reassures and offers a retry", () => {
    const m = html(createElement(WorkspaceError, { error: new Error("boom"), reset: () => {} }));
    expect(m).toContain("could not be loaded");
    expect(m).toContain("Try again");
    expect(m).not.toContain("boom"); // internal error text never reaches the page
  });
  it("EmptyState explains what will appear", () => {
    expect(html(createElement(EmptyState, { title: "No entries yet", description: "Changes will appear here." }))).toContain("Changes will appear here.");
  });
  it("an empty audit log shows its empty state, not a blank table", () => {
    const m = html(createElement(AuditList, { workspaceId: "w", timeZone: "UTC", initial: { items: [], nextCursor: null } }));
    expect(m).toContain("No entries yet");
    expect(m).not.toContain("Load older entries");
  });
  it("a partial audit log offers to load older entries", () => {
    const item = { id: "1", action: "workspace.created", actorUserId: "u", actorName: "Ann", entityType: null, entityId: null, summary: {}, createdAt: "2026-11-13T00:00:00Z" };
    const m = html(createElement(AuditList, { workspaceId: "w", timeZone: "UTC", initial: { items: [item], nextCursor: "c" } }));
    expect(m).toContain("Ann created the workspace");
    expect(m).toContain("Load older entries");
  });
});
