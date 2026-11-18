import { describe, expect, it } from "vitest";
import { cleanPageUrl, CreateChatWidgetBody, UpdateChatWidgetBody } from "@crm/contracts";

describe("web chat contracts (widget v2)", () => {
  it("cleanPageUrl keeps origin + path only", () => {
    expect(cleanPageUrl("https://a.example/p/q?token=1#x")).toBe("https://a.example/p/q");
    expect(cleanPageUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(cleanPageUrl("javascript:alert(1)")).toBeNull();
    expect(cleanPageUrl("https://a.example/" + "a".repeat(300))).toBeNull();
    expect(cleanPageUrl(42)).toBeNull();
  });
  it("create defaults and update validation", () => {
    expect(CreateChatWidgetBody.parse({ name: "x" })).toMatchObject({ subtitle: "We reply here", position: "right", quickReplies: [], awayMode: false, defaultLanguage: "en", avatarUrl: null });
    expect(UpdateChatWidgetBody.safeParse({ avatarUrl: "http://a.example/x.png" }).success).toBe(false);
    expect(UpdateChatWidgetBody.safeParse({ quickReplies: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(UpdateChatWidgetBody.parse({ avatarUrl: "" }).avatarUrl).toBeNull();
  });
});
