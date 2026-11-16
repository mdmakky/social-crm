import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS } from "@crm/contracts";
import { checkPick, contentUrl, downloadFailureText, formatBytes, uploadFailureText } from "../lib/attachments";

describe("attachment helpers", () => {
  it("pre-checks type and size per kind with the server's limits", () => {
    expect(checkPick({ name: "a.png", size: 100 })).toBeNull();
    expect(checkPick({ name: "a.exe", size: 100 })).toMatch(/not supported/);
    expect(checkPick({ name: "a.png", size: 0 })).toMatch(/empty/);
    expect(checkPick({ name: "a.png", size: ATTACHMENT_LIMITS.image + 1 })).toMatch(/too large.*5\.0 MB/);
    expect(checkPick({ name: "a.mp4", size: ATTACHMENT_LIMITS.video })).toBeNull();
    expect(checkPick({ name: "a.pdf", size: 2000 }, { ...ATTACHMENT_LIMITS, document: 1000 })).toMatch(/1000 B/);
  });
  it("formats sizes", () => {
    expect([formatBytes(null), formatBytes(12), formatBytes(2048), formatBytes(5 * 1024 * 1024), formatBytes(25 * 1024 * 1024)]).toEqual(["", "12 B", "2 KB", "5.0 MB", "25 MB"]);
  });
  it("turns codes into plain language, never raw codes", () => {
    for (const c of ["media_expired", "too_large", "executable_content", "provider_auth", "nope", null]) expect(downloadFailureText(c)).toMatch(/\s/);
    expect(uploadFailureText("storage_not_configured", undefined)).toMatch(/not set up/);
    expect(uploadFailureText("internal_error", "boom")).toBe("The upload did not work. Try again.");
  });
  it("builds the content url from ids only", () => {
    expect(contentUrl({ id: "a", conversationId: "c" }, "w")).toBe("/v1/workspaces/w/conversations/c/attachments/a/content");
    expect(contentUrl({ id: "a", conversationId: "c" }, "w", true)).toMatch(/\?download=1$/);
  });
});
