import { expect, test } from "@playwright/test";
import { axe } from "./channel-helpers";
import { addMemberByEmail, register, seedContacts, signUpAndCreate } from "./helpers";

// Owner decisions D290-D292: remove/restore a contact's lead, per-agent value access, and one visible stage concept (no "Lifecycle stage").
test("remove and restore, value access for an agent, and no lifecycle stage", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Fixes Co");
  const [id] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@fixes.example" }]);
  const agentCtx = await browser.newContext();
  const agent = await agentCtx.newPage();
  const agentEmail = await register(agent, "Alex Agent");
  await addMemberByEmail(workspaceId, agentEmail, "agent");
  const url = `/w/${workspaceId}/contacts/${id}`;

  // owner sets stage and value
  await page.goto(url);
  await page.getByRole("button", { name: "Set stage to Qualified" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
  await page.getByLabel("Value", { exact: true }).fill("1200");
  await page.getByLabel("Value", { exact: true }).blur(); // autosaves; there is no Update button
  await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();

  // one stage concept: no lifecycle control on the page, in the list filters or in the new-contact dialog
  await expect(page.getByLabel("Lifecycle stage")).toHaveCount(0);
  await expect(page.getByText("Lifecycle stage")).toHaveCount(0);
  await axe(page, "contact@1280");

  // an agent without a grant: no value, no value-access controls, remove is disabled with a reason
  await agent.goto(url);
  await expect(agent.getByText("Value is hidden for your role.")).toBeVisible();
  await expect(agent.getByRole("group", { name: "Who can see the value" })).toHaveCount(0);
  await agent.getByRole("button", { name: "More actions" }).click();
  await expect(agent.getByRole("menuitem", { name: /Remove from pipeline/ })).toHaveAttribute("aria-disabled", "true");
  await expect(agent.getByRole("menuitem", { name: /Remove from pipeline/ })).toContainText("owner or admin");
  await agent.keyboard.press("Escape");
  await agent.goto(`/w/${workspaceId}/contacts`);
  await expect(agent.getByRole("button", { name: "Recently removed" })).toHaveCount(0);
  await expect(agent.getByText("1,200")).toHaveCount(0);

  // the owner grants access; the agent now sees the value
  await page.getByText("Value access", { exact: true }).click(); // collapsed by default (D308)
  const access = page.getByRole("group", { name: "Who can see the value" });
  await expect(access.getByLabel("Value access for Alex Agent")).toHaveValue("none");
  await access.getByLabel("Value access for Alex Agent").selectOption({ label: "Can see" });
  await expect(access.getByLabel("Value access for Alex Agent")).toHaveValue("view");
  await agent.goto(url);
  await expect(agent.getByLabel("Value", { exact: true })).toHaveValue(/1,?200/);
  await agent.goto(`/w/${workspaceId}/contacts`);
  await expect(agent.getByText(/1,200/).first()).toBeVisible();

  // revoke: hidden again
  await access.getByLabel("Value access for Alex Agent").selectOption({ label: "No access" });
  await expect(access.getByLabel("Value access for Alex Agent")).toHaveValue("none");
  await agent.goto(url);
  await expect(agent.getByText("Value is hidden for your role.")).toBeVisible();

  // remove from the pipeline: dialog says what happens, then the panel is back to "not tracked"
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove from pipeline" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText(/restore it any time from Leads, Recently removed/)).toBeVisible();
  await dlg.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Removed from the pipeline" }).first()).toBeVisible();
  await expect(page.getByText("Not tracked yet. Change anything here to start.")).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from pipeline" })).toHaveCount(0); // nothing to remove without a lead
  await page.keyboard.press("Escape");

  // Recently removed lists it; restore brings it back with its stage
  await page.goto(`/w/${workspaceId}/contacts`);
  await page.getByRole("button", { name: "Recently removed" }).click();
  const removed = page.getByRole("dialog");
  await expect(removed.getByRole("link", { name: "Ana Costa" })).toBeVisible();
  await axe(page, "removed@1280");
  await removed.getByRole("button", { name: "Restore Ana Costa" }).click();
  await expect(removed.getByText("Ana Costa is back in the pipeline.")).toBeVisible();
  await expect(removed.getByRole("heading", { name: "Nothing removed" })).toBeVisible();
  await page.screenshot({ path: "/tmp/ol2-removed-empty-1440.png" });
  await removed.getByRole("button", { name: "Done" }).click();
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Set stage to Qualified" })).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from pipeline" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Value", { exact: true })).toHaveValue(/1,?200/);

  // 375: contact page and removed list have no serious a11y problems
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(url);
  await axe(page, "contact@375");
  await page.screenshot({ path: "/tmp/ol2-contact-375.png", fullPage: true });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove from pipeline" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Not tracked yet. Change anything here to start.")).toBeVisible();
  await page.goto(`/w/${workspaceId}/contacts`);
  await page.getByRole("button", { name: "Recently removed" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Ana Costa" })).toBeVisible();
  await axe(page, "removed@375");
  await page.screenshot({ path: "/tmp/ol2-removed-375.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "/tmp/ol2-removed-1440.png" });
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await page.goto(url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "/tmp/ol2-contact-1440.png", fullPage: true });
  await agentCtx.close();
});
