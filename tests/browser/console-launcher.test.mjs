import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { newPage, nativeValues } from "./console-agents-browser-helpers.mjs";
import { nativeAdminComputeDriver, nativeAdminValues } from "./console-agents-test-support.mjs";

async function setup(t) {
  const fixture = await createConsoleAppFixture(t, {
    originHost: "console.oce.example.test",
    publicOrigin: true,
    authCookieDomain: "oce.example.test",
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: {
      enabled: true,
      domain: "agents.oce.example.test",
      sharedCookieDomain: "oce.example.test",
    },
    nativeAdminGatewayApiKey: async () => "fixture-native-key",
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/shared"),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Product", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Product Claw", nativeValues("launcher"));
  const initialRevision = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  const initial = await fixture.request("GET", path);
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("launcher", initial.data.origin),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id, initialRevision.revision.id);
  const access = (await fixture.request("GET", path)).data;
  assert.equal(access.status, "available");
  const other = await fixture.createAgent(namespace.id, "Research Claw", nativeValues("other"));
  const { page } = await newPage(t, fixture, {
    args: [
      ...fixture.browserArgs,
      "--host-resolver-rules=MAP console.oce.example.test 127.0.0.1,MAP *.agents.oce.example.test 127.0.0.1",
    ],
  });
  // Only the final gateway document is a stand-in. Discovery, sessions, and IAM
  // run through the real Fastify app, Better Auth, controller, and native IAM.
  await page
    .context()
    .route(`${access.origin}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Native workspace reached</h1>" }),
    );
  async function person(label, grants = []) {
    return fixture.createAccountWithPolicy(label, (principal) => {
      for (const [resourceKind, resourceId, actions] of grants) {
        const id = randomUUID();
        fixture.policy.roles.push({
          id,
          namespaceId: namespace.id,
          permissions: actions.map((action) => ({ action, resourceKind })),
        });
        fixture.policy.bindings.push({
          id,
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: id,
          resourceKind,
          resourceId,
        });
      }
    });
  }
  const namespaceGrant = ["namespace", namespace.id, ["read"]];
  const agentGrant = ["agent", agent.id, ["read", "administer"]];
  return {
    fixture,
    namespace,
    agent,
    other,
    access,
    path,
    page,
    person,
    namespaceGrant,
    agentGrant,
  };
}

async function login(page, fixture, credentials, path = "/console/launch") {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
}

test("launcher returns password sign-in to the only authorized Claw and chooser mode prevents redirect", async (t) => {
  const s = await setup(t);
  const owner = await s.person("workspace-owner", [s.namespaceGrant, s.agentGrant]);
  await login(s.page, s.fixture, owner.credentials);
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.access.origin);
  await s.page.goto(`${s.fixture.origin}/console/launch?choose=1`);
  await s.page.getByRole("link", { name: "Open Claw" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 1);
  assert.equal(await s.page.getByText("Research Claw").count(), 0);
  assert.equal(await s.page.getByText("Fleet administration", { exact: true }).count(), 0);
  assert.equal(
    await s.page.getByRole("link", { name: "Open Claw" }).getAttribute("href"),
    s.access.url,
  );
  await s.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await s.page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );
  // Explicit console navigation is not hijacked, and its switcher is chooser-only.
  await s.page.goto(`${s.fixture.origin}/console/namespaces`);
  await s.page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await s.page.setViewportSize({ width: 1100, height: 800 });
  await s.page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
  await s.page.getByRole("menuitem", { name: "Switch destination" }).click();
  await s.page.getByRole("link", { name: "Open Claw" }).waitFor();
  assert.equal(new URL(s.page.url()).searchParams.get("choose"), "1");
  await s.page.getByRole("button", { name: "Sign out" }).click();
  await s.page.getByRole("button", { name: "Login", exact: true }).waitFor();
  assert.equal(await s.page.getByText("Product Claw", { exact: true }).count(), 0);
  // Signing back in from the logout screen has no return parameter. It must
  // rediscover this account's destination instead of falling into administration.
  assert.equal(new URL(s.page.url()).searchParams.has("return"), false);
  await s.page.getByLabel("Username").fill(owner.credentials.email);
  await s.page.getByLabel("Password").fill(owner.credentials.password);
  await s.page.getByRole("button", { name: "Login", exact: true }).click();
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.access.origin);
  // An already authenticated visit to bare login uses the same default.
  await s.page.goto(`${s.fixture.origin}/console/login`);
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.access.origin);
});

test("launcher counts unavailable destinations and rechecks revoked exact-agent access", async (t) => {
  const s = await setup(t);
  const owner = await s.person("two-workspaces", [
    s.namespaceGrant,
    s.agentGrant,
    ["agent", s.other.id, ["read", "administer"]],
  ]);
  await login(s.page, s.fixture, owner.credentials);
  await s.page.getByRole("heading", { name: "Research Claw" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 2);
  assert.equal(await s.page.getByRole("link", { name: "Open Claw" }).count(), 1);
  assert.match(
    await s.page.getByRole("article").filter({ hasText: "Research Claw" }).innerText(),
    /Stopped/,
  );
  // Leave read access in place while removing administer; a readable Agent is not a destination.
  const binding = s.fixture.policy.bindings.find(
    (b) => b.subjectId === owner.principal.id && b.resourceId === s.agent.id,
  );
  s.fixture.policy.roles.find((r) => r.id === binding.roleId).permissions = [
    { resourceKind: "agent", action: "read" },
  ];
  await s.page.getByRole("button", { name: "Refresh availability" }).click();
  await s.page.getByRole("heading", { name: "Your workspace is unavailable" }).waitFor();
  assert.equal(await s.page.getByText("Product Claw", { exact: true }).count(), 0);
  // An explicit return to the revoked Agent never opens the other assigned Claw.
  await s.page.goto(
    `${s.fixture.origin}/console/launch?namespace=${s.namespace.id}&agent=${s.agent.id}`,
  );
  await s.page.getByRole("heading", { name: "You don’t have access to this Claw" }).waitFor();
  assert.equal(await s.page.getByText("Research Claw", { exact: true }).count(), 0);
});

test("launcher does not mistake partial discovery or an unknown administration result for a complete list", async (t) => {
  const s = await setup(t);
  const owner = await s.person("workspace-owner", [s.namespaceGrant, s.agentGrant]);
  const failure = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE" }, meta: {} }),
    });
  await s.page.route(`${s.fixture.origin}/observability`, failure);
  await login(s.page, s.fixture, owner.credentials);
  await s.page.getByRole("heading", { name: "We couldn’t load your workspaces" }).waitFor();
  assert.equal(await s.page.getByText("No access assigned").count(), 0);
  await s.page.unroute(`${s.fixture.origin}/observability`, failure);
  await s.page.route(`${s.fixture.origin}${s.path}`, failure);
  await s.page.getByRole("button", { name: "Try again" }).click();
  await s.page.getByRole("heading", { name: "We couldn’t load your workspaces" }).waitFor();
  assert.equal(new URL(s.page.url()).pathname, "/console/launch");
  await s.page.unroute(`${s.fixture.origin}${s.path}`, failure);
  await s.page.getByRole("button", { name: "Try again" }).click();
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
});

test("launcher shows no-access intentionally and ignores malicious return URLs", async (t) => {
  const s = await setup(t);
  const empty = await s.person("Unassigned");
  await login(s.page, s.fixture, empty.credentials);
  await s.page.getByRole("heading", { name: "No access assigned" }).waitFor();
  assert.equal(await s.page.getByText("Product Claw", { exact: true }).count(), 0);
  await s.page.getByRole("button", { name: "Check again" }).click();
  await s.page.getByRole("heading", { name: "No access assigned" }).waitFor();
  await s.page.getByRole("button", { name: "Sign out" }).click();
  await s.page.getByRole("button", { name: "Login", exact: true }).waitFor();
  await login(
    s.page,
    s.fixture,
    empty.credentials,
    "/console/login?return=" + encodeURIComponent("//attacker.example.test/console/launch"),
  );
  await s.page.getByRole("heading", { name: "No access assigned" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.fixture.origin);
});

test("launcher checks Installation administer separately from Agent permissions", async (t) => {
  const s = await setup(t);
  await login(s.page, s.fixture, s.fixture.credentials);
  await s.page.getByRole("heading", { name: "Fleet administration" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 3);
  // Reduce the fixture administrator to an exact Installation binding. That no
  // longer grants any Agent destination, but administration remains available.
  s.fixture.policy.bindings[0].resourceKind = "installation";
  s.fixture.policy.bindings[0].resourceId = s.fixture.controller.installation.id;
  await s.page.getByRole("button", { name: "Refresh availability" }).click();
  await s.page.waitForURL(/\/console\/namespaces/);
  await s.page.goto(`${s.fixture.origin}/console/launch?choose=1`);
  await s.page.getByRole("link", { name: "Open administration" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 1);
});
