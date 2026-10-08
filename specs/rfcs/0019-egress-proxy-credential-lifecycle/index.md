---
author: freeqaz-openai
implementation_status: Not implemented
status: Proposed
---

# Egress Proxy and credential lifecycle

- **ID:** RFC-0019
- **Created:** 2026-10-06
- **Updated:** 2026-10-08
- **RFC PR:** [#1530](https://github.com/openclaw/openclaw-enterprise/pull/1530)

## Problem and proposal

Agents need GitHub, inference, and other services without managing provider credentials. This proposal composes an **Egress Proxy**, credential resolver, Secret Driver, and Token Service. OpenClaw Control Plane (OCC) owns current authorization; trusted data-plane senders enforce it and forward requests. V1 targets static sources, GitHub App, Codex OAuth, and custom dynamic credentials. OpenShell is the V1 production candidate, not a qualified integration. The Agent's OpenClaw Gateway is separate.

![Proposed logical credential path](assets/overview.svg)

_Proposed relationships; dashed arrows do not assert an implemented integration. Roles need not be separate services. See the [editable diagram](assets/overview.mmd) and [lifecycle phases](lifecycle.md)._

## Roles and deployment

| Role                | Responsibility                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| OCC                 | Admit sources and Agent bindings; maintain grants, execution identity, and current authorization. |
| Egress Proxy        | Capture operations, enforce their admitted routes, inject permitted material, and forward.        |
| Credential resolver | Resolve a binding and authorized use to static material or an already-warm dynamic token.         |
| Secret Driver       | Read referenced static credentials or Token Service inputs from a configured store.               |
| Token Service       | Prepare and refresh dynamic credentials in the background; expose readiness and warm-only reads.  |
| Compute / bootstrap | Prepare an optional repository before startup; own completion and cleanup.                        |

The Egress Proxy Driver configures and observes the proxy. The existing Credential Gateway Driver manages source registration and revision attachment, not forwarding. One adapter may implement several roles.

| Custody   | Owner                          | Required boundary                                        |
| --------- | ------------------------------ | -------------------------------------------------------- |
| Central   | OCE-managed credential runtime | Owns material and refresh.                               |
| Delegated | Conforming adapter             | Owns material and refresh under admitted custody policy. |
| Both      | May coexist across families    | Each rotating family has one canonical lifecycle owner.  |

Source policy must permit material to reach a trusted sender outside the workload. Route restrictions do not narrow a stolen provider bearer.

| Profile           | Egress behavior                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| CI                | No-op egress and fixtures are allowed; they do not establish enforcement. |
| Local development | No-op/fixtures or a production-style adapter.                             |
| Hardened          | Require selected enforcement capabilities; no no-op fallback.             |

**Open:** Which roles can OpenShell satisfy, and where are OCE-owned components or upstream hooks needed? Horizontal proxy HA and mTLS identity are later work.

## Authorization and forwarding

Each Agent needs an authorized binding and identity, even for a shared source. A binding identifies source, backend, provider kind, and scope; a reference grants no permission. The existing Namespace-scoped ServicePrincipal is the stable Agent identity. Its bearer is distinct from provider credentials and authenticates the current execution. Issuance, delivery, lifetime, and bootstrap delegation remain open.

For every supported outbound operation, including credential-free egress:

1. The trusted proxy identifies the execution, captures the actual destination and operation, and selects the exact admitted route and binding when needed.
2. It checks current authority before material access and resolves only when credentials are needed. Ambiguous routes, unsupported operations, and insufficient scope fail closed; a request cannot select another backend or widen its grant.
3. After transformations and awaited preparation, the authenticated sender makes a fresh OCC check of the exact execution, versioned route, grant, selected material identity/version when applicable, and immutable operation, including destination and policy-relevant content. Success permits one send within a short start deadline and the original operation deadline.
4. Each redirect, retry, or new operation on a reused connection requires a new check. Recovery cannot recreate permission to send.

| Limits and withdrawal | Contract                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Must**              | Never cache allows. Refuse new operations when OCC or current authority is unavailable, including material-cache hits.                                                                                                  |
| **Must**              | Carry a finite short send-start deadline and the original absolute operation deadline to the trusted sender. The sender enforces both for local forwarding; preparation or retry must not extend the original deadline. |
| **Must**              | Activate scope expansion after required dynamic material is prepared and authority is rechecked; narrower access may continue meanwhile. Apply reductions to subsequent checks without waiting for replacement.         |
| **Accepted gap**      | A check can race a committed reduction or hold: an already-checked operation may start after acknowledgment. An underway operation can continue until its original deadline.                                            |
| **Accepted gap**      | Cancellation is best effort. A local timeout does not prove provider cancellation or undo effects. External IdP offboarding may reach OCE later.                                                                        |
| **Open**              | Deadline values and time protocol, and enforcement for each transport; native IAM only or external implementations too. Ordered admission and renewable stream leases are follow-up work.                               |

| Forwarding and response policy | Contract                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Must**                       | Prevent direct bypass; bind policy to actual destination and protocol authority; strip Agent authentication before forwarding.                                       |
| **Must**                       | Keep credentials out of Agent files and diagnostics.                                                                                                                 |
| **Must**                       | Apply trusted provider-specific response policy; default to pass-through only where permitted. Redact or refuse as required.                                         |
| **Must**                       | Do not use unchecked pass-through for providers that may return credentials. Refuse if required handling cannot cover headers, body, trailers, encoding, or streams. |

| Protocol | Contract                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Must** | Deny opaque SSH, database, and other traffic without authorizable individual operations.                                            |
| **Must** | UDP/QUIC may be deferred but cannot bypass enforcement.                                                                             |
| **Open** | Future support needs protocol-specific operation boundaries, adapter capabilities, and enforcement tests. DNS needs its own design. |

**Open:** Dedicated Codex normally uses a [Responses WebSocket](../../../docs/reference/harness-execution.md). The [pinned 0.160.0 release](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client.rs#L1918-L1925) supports HTTP/SSE fallback on an initial `426` handshake. Can we qualify that path, and can OpenShell perform the final online check after preparation and before send?

## Credential resolution

### Declarative configuration and request APIs

Operators declare **Agent binding → credential source → backend instance → provider kind**, with an approved grant. OCC validates schemas, capabilities, and scope and records a versioned route. These declarations can extend existing records; the example does not prescribe resource types or a wire schema.

```yaml
backends:
  primary: { driver: openshell }
credentialSources:
  company-github:
    backendRef: primary
    kind: github-app/v1
    providerRef: provider-uuid
agentBindings:
  repo-reader:
    agentRef: build-agent
    sourceRef: company-github
    grant:
      repositoryIds: ["123"]
      permissions: { contents: read }
```

A placeholder or endpoint rule selects the binding. The resolver follows that exact route; requests cannot load a driver, select another source, or widen scope. The provider adapter classifies the actual operation against the normalized grant. A compiled route is configuration, not cached authorization.

| Proposed library API                             | Contract                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `egress.forRequest(request).forward(bindingRef)` | A trusted integration binds one authenticated, immutable operation. The proxy owns check, resolve, inject, send, and response policy. |
| `resolve({ request, bindingRef, freshness })`    | Trusted adapters receive a use-bound opaque handle or `Denied`, `NotReady`, or `Unavailable`. Resolution does not permit a send.      |
| `authorizer.check(context)`                      | The trusted runtime asks OCC for current authority before resolution and again after preparation, immediately before send.            |

| Required check context                                                                             | Before resolution | Final check                                                             |
| -------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| Authenticated execution and immutable operation, including destination and policy-relevant content | Required          | Required, exact operation to be sent                                    |
| Exact admitted versioned route and grant                                                           | Required          | Required; the exact route and grant used                                |
| Selected credential identity and version, nonsecret                                                | Not yet selected  | Required for credentialed use; explicit absence for credential-free use |

If the route or grant changes during preparation, re-admit and repeat the necessary checks. Credential-free operations still require an admitted egress route and grant. Credential bytes never go to policy. Context comes from the authenticated boundary, not caller assertions. A handle is use-bound and single-use; it prevents trusted-caller mistakes, not hostile code in the same process. GitHub classification checks the actual repository and action against admitted IDs and permissions. Static sources use the same checks. Agents use normal clients or placeholders and receive no material handle. Names and fields are proposed contracts, not finalized wire APIs or existing OCE implementation.

### Static credentials

The Secret Driver reads the current value at the configured reference. Value updates require no source update or Agent redeploy. Reference or configuration changes require admission; failure preserves the previous configuration. Configuration generation and Secret material version are distinct.

| Default or failure                                                                  | Rule                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Freshness                                                                           | Proposed per-source default: 10 minutes.                                   |
| Temporary store failure                                                             | Eligible failures may use stale material for at most four hours total age. |
| Zero cache period                                                                   | Disable reusable retention and stale fallback across serving layers.       |
| Denial, known revocation, missing material, unknown error, or unavailable authority | Fail closed.                                                               |

Fallback requires typed errors and trustworthy value-age evidence across all serving cache layers. Generic unavailability is insufficient. Age starts at the last trustworthy authoritative observation; failed reads and lower-cache hits do not reset it. Recheck usability at dispatch.

**Open:** What read path and freshness evidence can each Secret Driver and OpenShell implementation provide, including external Secret changes?

### Dynamic credentials

1. OCC pushes admitted configuration to Token Service, which prepares and refreshes credentials in the background, even without requests. It uses the Secret Driver for long-lived inputs where practical.
2. The proxy reads an already-warm token scoped to the binding and operation. A cold or expired lookup returns `NotReady`; it neither mints nor schedules refresh. Tokens are keyed by source generation, normalized grant, and isolation boundary: a read grant cannot borrow a broader token. V1 has no dynamic-token push or proxy-side dynamic-token cache.
3. Each rotating family needs one fenced refresher before it consumes a rotating input, and durable replacement state before readiness. A timeout does not settle an upstream refresh. Reconcile a lost response with the provider or require reauthorization; never blindly replay it.
4. On warm-token rejection, the proxy returns the failure without automatic retry and sends authenticated feedback naming the exact source configuration, grant, and token version. Provider-specific classification distinguishes credential rejection from other failures. Token Service refreshes or marks the source unhealthy in the background; a late rejection of version N cannot invalidate N+1. Response policy still applies. Distinguish pre-send refusal, a known or blocked response, provider rejection, and possible dispatch; an uncertain dispatch must not be automatically resent.

**Open:** Which store and fencing mechanism own each rotating family? How does Codex obtain account metadata and reconnect without a provider credential in the workload? Reconcile the earlier [Token Service proposal](https://github.com/openclaw/openclaw-enterprise/pull/924), which differs on renewal, execution identity, custody, and startup readiness, before treating it as superseded. [#1559](https://github.com/openclaw/openclaw-enterprise/pull/1559) proposes a Codex receiver, not the supplier.

## Examples and startup

**Static inference:** An owner registers a source and grants use to the caller and Agent principal. The owner lists it in `credentialSources` and selects it with `harnessAuth`. The proxy resolves the key, obtains the final OCC check, injects it, and forwards.

**GitHub bootstrap:** Token Service signs an App JWT with a GitHub App private key and exchanges it for an installation token scoped to admitted repository IDs and permissions. The adapter validates returned authority against that exact normalized grant, including provider-required baseline permissions, and checks expiry. For a configured repository, trusted bootstrap clones through the same authorized egress path before Agent startup.

Required dynamic credentials wait for readiness with a bounded timeout. Failed or uncertain clone blocks startup by default; custom setup may opt out of that gate, but not authorization. Compute/bootstrap owns partial-workspace cleanup. Repositories remain optional and first-class. Removing Repo Driver as a separate implementation requires explicit owners for discovery, profiles, grants, sessions, deadlines, and cleanup; revision selection and setup are later work.

Agent owners see provisioning and credential readiness or failure and receive notice when use is threatened. Platform operators see refresh failures and approaching expiry. Alert channels and thresholds remain open.

**Open:** How is bootstrap authority delegated and how does Compute prove clone completion? Which exact GitHub permissions and repository mapping does V1 support?

## Delivery and verification

[#851](https://github.com/openclaw/openclaw-enterprise/pull/851) supplies credential-source and Agent-revision foundations, not the proposed proxy path, warm-only refresh, dynamic rotation, or repository preclone. Workload-token verification and identity exchange remain deferred; an accepted deployment does not establish warm credentials or Agent readiness. Codex remains at `0.160.0`.

Validate replacement attachments before stopping a working Agent; allow accepted cleanup after source-use permission is removed. The inspected OpenShell [middleware](https://github.com/NVIDIA/OpenShell/blob/6144a7beb92e32e1fd41c798aec7aaf6d9ff0b29/crates/openshell-supervisor-network/src/l7/relay.rs#L1981-L2108) precedes credential preparation; its [token-grant miss](https://github.com/NVIDIA/OpenShell/blob/6144a7beb92e32e1fd41c798aec7aaf6d9ff0b29/crates/openshell-supervisor-network/src/token_grant.rs#L247-L286) can issue a token. Neither establishes the final online check or a warm-only read.

Qualify the connected path with static inference, GitHub preclone, Codex OAuth, and a custom dynamic type. Verify cross-Agent and cross-Namespace denial, revocation races and partitions, protocol and bypass handling, rotation, cache bounds, background refresh, bounded startup, and cleanup after uncertainty. Source review, installed runtime evidence, and live-provider evidence are distinct. See the [Credential Gateway Driver RFC](../0016-sandbox-credential-injection.md), [Agent egress RFC](../0017-agent-egress-0x/index.md), and [credential source contract](../../../docs/reference/credential-sources.md).

## Appendix: failure and recovery

| Case                      | Required handling                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Static rotation           | Establish replacement visibility and adoption by every serving proxy and resolve old-key in-flight use before ordinary retirement. Emergency revocation may come first.                                                                                                                                |
| Withdrawal                | Checks observing the reduction deny unauthorized operations, including cache hits; the accepted check-to-send race and original operation deadline still apply.                                                                                                                                        |
| Restart or uncertainty    | A cold static read has no stale fallback; restored Token Service configuration is not warm readiness. Retain the original owner, deadline, and cleanup obligation for an uncertain send, refresh, or clone. Reconcile a potentially dispatched effect before replay.                                   |
| Confirmed last-owner loss | An OCE operator disabling or removing the last authorized owner triggers a hold and asynchronous parking. The hold blocks new execution and protects retained data, subject to the check-to-send race.                                                                                                 |
| Owner uncertainty         | Unknown owner state is not confirmed loss. A team Agent with remaining owners does not park solely because one leaves. External IdP synchronization is later work.                                                                                                                                     |
| Containment               | Report incomplete containment. Only an authorized hold release permits new execution.                                                                                                                                                                                                                  |
| Fork                      | An authorized fork copies readable content into independent storage, starts stopped with fresh identity, and inherits no credentials or grants. Copied automation remains inert until admitted. See [parking and forks](lifecycle.md#parking-and-forks) for containment, preservation, and copy rules. |
