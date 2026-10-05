import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

// Gateway storage and Compute placement are test doubles. Requests use the real
// Fastify app, authentication, IAM, OCC transactions, and OpenShell Driver.
async function fixture(t) {
  const providers = new Map();
  const profiles = new Map();
  const mutations = [];
  const key = (workspace, name) => workspace + "/" + name;
  const client = {
    async getProviderProfile(workspace, id) {
      return profiles.get(key(workspace, id));
    },
    async importProviderProfile(workspace, profile) {
      mutations.push("importProfile");
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async deleteProviderProfile(workspace, id) {
      mutations.push("deleteProfile");
      profiles.delete(key(workspace, id));
    },
    async createProvider(input) {
      const id = key(input.workspace, input.name);
      if (providers.has(id)) {
        throw new OpenShellProviderAlreadyExistsError();
      }
      mutations.push("createProvider");
      providers.set(id, structuredClone(input));
      return providers.get(id);
    },
    async getProvider(workspace, name) {
      return providers.get(key(workspace, name));
    },
    async listProviders(workspace) {
      return [...providers.values()].filter((provider) => provider.workspace === workspace);
    },
    async deleteProvider(workspace, name) {
      mutations.push("deleteProvider");
      providers.delete(key(workspace, name));
    },
    async updateProviderCredentials(workspace, name, credentials) {
      mutations.push("updateProvider");
      providers.get(key(workspace, name)).credentials = structuredClone(credentials);
    },
    close() {},
  };
  const backend = createOpenShellBackend(
    {
      id: "openshell-test",
      type: "openshell",
      configuration: { endpoint: "http://127.0.0.1:1" },
      drivers: { credential_gateway: "openshell-credentials", sandbox: "openshell-sandbox" },
    },
    { gatewayClient: client },
  );
  const driver = new OpenShellCredentialGatewayDriver(
    { binaries: ["/app/bin/codex"] },
    {
      id: "openshell-credentials",
      backend,
    },
  );
  let now = Date.parse("2026-10-05T12:00:00Z");
  const computeDriver = {
    ...createDevelopmentComputeDriver({ id: "credential-source-compute" }),
    async resolveSandboxNamespace(namespace) {
      return namespace;
    },
  };
  const app = await createConsoleAppFixture(t, { now: () => new Date(now), computeDriver });
  await app.bootstrap();
  app.controller.registerDriver(driver);
  app.controller.selectDriver("credential_gateway", driver.id);
  const namespace = await app.createNamespace("credential-test", { ready: true });
  const path = "/namespaces/" + namespace.id + "/credential-sources";
  const secret = await app.createSecret(namespace.id, "model-key", "synthetic-model-key");
  const create = (name, config = {}) =>
    app.request("POST", path, {
      body: { name, type: "openai", config, secrets: { api_key: secret.ref } },
    });
  return {
    ...app,
    driver,
    client,
    providers,
    profiles,
    mutations,
    namespace,
    path,
    create,
    passRegistrationFence() {
      now += 71_000;
    },
    async seedInvalid(type = "openai") {
      // Reproduce the historical failed registration: no remote mutation ever ran,
      // but OCC retained a deleting row. Its age is beyond the registration fence.
      const source = {
        id: "cs_" + randomUUID(),
        namespaceId: namespace.id,
        name: "invalid-" + randomUUID(),
        type,
        config: { base_url: "http://" },
        secrets: { api_key: secret.ref },
        driverId: driver.id,
        state: "registering",
        createdAt: new Date(now - 71_000).toISOString(),
      };
      await app.controller.transact(async (unit) => {
        await unit.credentialSources.createCredentialSource(source);
        await unit.credentialSources.markCredentialSourceDeleting(namespace.id, source.id);
      });
      return source;
    },
  };
}

test("credential source HTTP admission rejects invalid endpoints without retaining records", async (t) => {
  const f = await fixture(t);
  for (const base_url of [
    "http://",
    "https://models.example.test",
    "http://models.example.test/v1",
    "https://models.example.test/*/v1",
    "https://models.example.test/v1?option=value",
    "https://models.example.test/v1#fragment",
  ]) {
    const response = await f.create("invalid", { base_url });
    // Assert absence independently of the status: the original bug left a deleting row.
    assert.deepEqual((await f.request("GET", f.path)).data, [], base_url);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.deepEqual(response.body.error.details, [
      { path: "/config/base_url", code: "INVALID_VALUE" },
    ]);
    assert.match(response.body.error.message, new RegExp("HTTPS.*/v1"));
  }
  assert.deepEqual(f.mutations, []);
  assert.equal(f.providers.size, 0);
  assert.equal(f.profiles.size, 0);
});

test("credential source HTTP deletion recovers invalid stored endpoints without touching profiles", async (t) => {
  const f = await fixture(t);
  const healthy = await f.create("healthy");
  assert.equal(healthy.status, 201, JSON.stringify(healthy.body));
  const profilesBefore = structuredClone([...f.profiles]);
  const source = await f.seedInvalid();
  const path = f.path + "/" + source.id;
  const read = await f.request("GET", path);
  assert.equal(read.status, 200);
  assert.equal(read.data.status.state, "absent");
  assert.equal((await f.request("DELETE", path)).status, 204);
  assert.equal((await f.request("GET", path)).status, 404);
  assert.deepEqual([...f.profiles], profilesBefore);
  assert.equal((await f.request("GET", f.path + "/" + healthy.data.id)).data.status.state, "ready");

  // An unexpected remote resource is not evidence of absence. Even source labels
  // cannot prove its profile from an invalid endpoint; preserve both objects.
  const collision = await f.seedInvalid();
  const existing = [...f.providers.values()][0];
  const foreign = {
    ...existing,
    name: openShellProviderName(collision.id),
    labels: { ...existing.labels, "openclaw.dev/credential-source-id": collision.id },
  };
  f.providers.set(foreign.workspace + "/" + foreign.name, foreign);
  const collisionPath = f.path + "/" + collision.id;
  assert.equal((await f.request("GET", collisionPath)).data.status.state, "failed");
  assert.notEqual((await f.request("DELETE", collisionPath)).status, 204);
  assert.equal((await f.request("GET", collisionPath)).data.state, "deleting");
  assert.ok([...f.providers.values()].includes(foreign));
  assert.deepEqual([...f.profiles], profilesBefore);

  const unknown = await f.seedInvalid("unknown");
  assert.notEqual((await f.request("DELETE", f.path + "/" + unknown.id)).status, 204);
  assert.equal((await f.request("GET", f.path + "/" + unknown.id)).data.state, "deleting");
});

test("OpenShell custom and default credential profiles keep independent ownership and lifecycle", async (t) => {
  const f = await fixture(t);
  const standard = await f.create("default");
  const custom = await f.create("custom", { base_url: "https://MODELS.example.test:8443/api/v1/" });
  const shared = await f.create("shared", { base_url: "https://models.example.test:8443/api/v1" });
  for (const result of [standard, custom, shared]) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.data.status.state, "ready");
    assert.equal(
      (await f.request("GET", f.path + "/" + result.data.id)).data.status.state,
      "ready",
    );
  }
  const customProfile = [...f.profiles.values()].find((profile) => profile.id !== "oce-openai");
  assert.equal(f.profiles.size, 2);
  assert.match(customProfile.id, /^oce-openai-[0-9a-f]{12}$/);
  assert.deepEqual(customProfile.endpoints, [
    { host: "models.example.test", port: 8443, protocol: "rest", path: "/api/v1/**" },
  ]);
  assert.deepEqual(customProfile.binaries, ["/app/bin/codex"]);
  const provider = [...f.providers.values()].find(
    (row) => row.name === openShellProviderName(custom.data.id),
  );
  const source = await f.controller.transact((unit) =>
    unit.credentialSources.findCredentialSource(f.namespace.id, custom.data.id),
  );
  const context = {
    namespace: { ...f.namespace, name: provider.workspace },
    source,
    signal: AbortSignal.timeout(5000),
  };
  // Native OpenClaw cannot use a custom endpoint. Codex can attach only the source's profile.
  await assert.rejects(
    f.driver.attachForRevision({
      ...context,
      sources: [source],
      revision: { harness: { id: "openclaw", mode: "dedicated" } },
    }),
    /default OpenAI endpoint/,
  );
  assert.deepEqual(
    await f.driver.attachForRevision({
      ...context,
      sources: [source],
      revision: { harness: { id: "codex", mode: "dedicated" } },
    }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
  provider.type = "oce-openai";
  assert.equal((await f.request("GET", f.path + "/" + custom.data.id)).data.status.state, "failed");
  await assert.rejects(
    f.driver.registerSource(context, {
      type: "openai",
      config: custom.data.config,
      secrets: { api_key: "synthetic-model-key" },
    }),
    /not owned/,
  );
  await assert.rejects(f.driver.removeSource(context), /not owned/);
  provider.type = customProfile.id;
  assert.equal((await f.request("PATCH", f.path + "/" + custom.data.id, { body: {} })).status, 200);
  f.passRegistrationFence();
  assert.equal((await f.request("DELETE", f.path + "/" + custom.data.id)).status, 204);
  assert.equal(f.profiles.size, 2, "another source still needs the custom profile");
  assert.equal((await f.request("DELETE", f.path + "/" + shared.data.id)).status, 204);
  assert.deepEqual(
    [...f.profiles.values()].map((profile) => profile.id),
    ["oce-openai"],
  );
  assert.equal(
    (await f.request("GET", f.path + "/" + standard.data.id)).data.status.state,
    "ready",
  );
  assert.equal((await f.request("DELETE", f.path + "/" + standard.data.id)).status, 204);
  assert.equal(f.profiles.size, 0);
  assert.equal(f.providers.size, 0);
});
