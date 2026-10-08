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

Agents in OpenClaw Enterprise (OCE) need inference, GitHub, and other services without managing provider credentials.

- **Today:** [#851](https://github.com/openclaw/openclaw-enterprise/pull/851) supplies credential-source and Agent-revision foundations. The [current workflow](../../../docs/reference/credential-sources.md#update-a-source) registers a static copy; rotation requires a source update and redeploy. A running Agent retains the old value until its Harness restarts.
- **Proposed:** A shared resolver serves trusted egress. Static sources reread their referenced Secret and adopt value changes without source updates or redeploys. Token Service proactively prepares and refreshes dynamic credentials.
- **Still unqualified:** The composed path; OpenShell is the V1 production candidate. V1 targets static sources, GitHub App, Codex OAuth, and custom dynamic credentials.

**Review decision:** Assess the logical contracts, custody choices, lifecycle and failure semantics, and accepted V1 check-to-send race. Live Secret adoption is selected; [cutover and authority consequences](lifecycle.md#live-secret-cutover) need implementation design.

![Proposed logical credential path](assets/overview.svg)

_Proposed relationships; dashed arrows do not assert an implemented integration. Roles need not be separate services. See the [editable diagram](assets/overview.mmd) and [lifecycle phases](lifecycle.md)._

## Roles and deployment

OpenClaw Control Plane (OCC) is the control-plane authority; a trusted data-plane runtime captures and sends operations. The following are logical contracts, not a process layout. One OpenShell adapter may implement several contracts. The Agent's OpenClaw Gateway is separate.

| Contract owner      | Responsibility                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- |
| OCC                 | Admit sources and bindings; maintain grants, execution identity, and current authorization. |
| Egress Proxy        | Capture operations, enforce admitted routes, inject material, and forward.                  |
| Credential resolver | Select static material or an already-warm dynamic token for authorized use.                 |
| Secret Driver       | Read referenced static credentials or Token Service inputs.                                 |
| Token Service       | Prepare and refresh dynamic credentials; expose readiness and warm-only reads.              |
| Compute / bootstrap | Prepare an optional repository; own completion and cleanup.                                 |

The **Egress Proxy Driver** configures and observes the proxy. The existing **Credential Gateway Driver** manages source registration and revision attachment.

| Custody   | Material and refresh owner                        |
| --------- | ------------------------------------------------- |
| Central   | OCE-managed credential runtime.                   |
| Delegated | Conforming adapter under admitted custody policy. |

Both may coexist across families; each rotating family has one canonical lifecycle owner. Source policy must permit material to reach a trusted sender outside the workload. Route restrictions do not narrow a stolen provider bearer.

CI and local development permit no-op egress and fixtures; local development also permits production-style adapters. No-op paths do not establish enforcement. Hardened deployments require selected enforcement capabilities without no-op fallback. Horizontal proxy HA and mTLS identity are later work.

## Authorization and forwarding

The Namespace-scoped ServicePrincipal is the stable Agent identity; execution identity authenticates a particular run with a separate bearer from provider credentials. Binding, issuance, delivery, lifetime, and bootstrap delegation remain implementation work.

Every outbound operation follows this path, including credential-free egress:

1. **Trusted proxy:** Authenticate the execution and capture the actual destination, protocol authority, and immutable operation, including policy-relevant content.
2. **Proxy:** Select the exact admitted route and credential binding when needed. Refuse ambiguous routes, unsupported operations, or insufficient scope. Each Agent needs its own authorized binding even for shared sources; references grant no permission.
3. **Proxy and OCC:** Check current authority online over the execution, versioned route, grant, and operation before material access.
4. **Resolver:** Read static material or an already-warm dynamic token for that use. Resolution returns a use-bound, single-use handle, not permission to send.
5. **Authenticated trusted sender and OCC:** After transformations and awaited preparation, freshly check the exact immutable operation, execution, versioned route, grant, and selected nonsecret material identity/version, or explicit absence for credential-free use. Changed routes or grants require re-admission and repeated checks.
6. **Trusted sender:** Inject permitted material, send once, and apply response policy. Every redirect, retry, or new operation on a reused connection requires a new check; recovery cannot recreate send permission.

Context comes from the authenticated boundary, not caller assertions. Policy never receives credential bytes. Agents use normal clients or placeholders and receive no material handles. Handles prevent trusted-caller mistakes, not hostile code in the same process.

**Accepted V1 race:** A final check can race a committed reduction or hold; an already-checked operation may start after acknowledgment. An underway operation may continue until its original deadline. The sender must receive and enforce a finite short send-start deadline and the original absolute operation deadline; preparation and retries cannot extend it. Cancellation is best effort: local timeout does not prove provider cancellation or undo effects. Ordered admission and renewable stream leases are later work.

## Credential resolution

### Declarative configuration and request APIs

Operators declare **Agent binding → credential source → backend instance → provider kind**, with an approved grant. For example, `repo-reader` binds an Agent to `company-github`, whose backend and provider kind supply GitHub credentials; its grant permits only repository `123` contents reads. OCC validates schemas, capabilities, and scope, then compiles a route fixing those identities and configuration generations. Material version identifies the credential value and can change independently.

Conceptual configuration; these declarations may extend existing records and do not prescribe resource types or wire schemas:

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

Trusted integrations supply placeholders or endpoint rules from admitted operator configuration to select the binding. Requests cannot load drivers, select another source/backend, or widen grants. The provider adapter classifies the actual operation against the normalized grant, including GitHub repository IDs and actions. Static sources follow the same checks. Credential-free operations still need an admitted route and grant. Compiled routes are configuration, never cached authorization.

Conceptual library contracts, not existing APIs:

| API                                              | Contract                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `egress.forRequest(request).forward(bindingRef)` | Bind an authenticated, immutable operation; own checks, resolution, injection, send, and response policy. |
| `resolve({ request, bindingRef, freshness })`    | Return an opaque use-bound handle or `Denied`, `NotReady`, or `Unavailable` to trusted adapters.          |
| `authorizer.check(context)`                      | Ask OCC for current authority before resolution and after preparation, immediately before send.           |

### Static credentials

The selected behavior rereads the current Secret value without source updates or Agent redeploys. Reference/configuration changes still require admission; failure preserves the previous configuration.

| Condition                                                                        | Contract                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Freshness                                                                        | Proposed per-source default: 10 minutes.                             |
| Eligible temporary store failure                                                 | Permit stale material for at most four hours **total age**.          |
| Zero cache period                                                                | Disable reusable retention and stale fallback across serving layers. |
| Denial, known revocation, missing material, unknown error, unavailable authority | Fail closed.                                                         |

A value authoritatively observed at 09:00 reaches its freshness limit at 09:10; eligible fallback ends by 13:00. Fallback requires typed errors and trustworthy age evidence across every serving cache layer; generic unavailability is insufficient. Age starts at the last trustworthy authoritative observation; failed reads and lower-cache hits cannot reset it. Cold reads have no stale fallback. Recheck usability at dispatch.

### Dynamic credentials

OCC pushes admitted configuration to Token Service, which prepares and refreshes credentials in the background even without requests, using Secret Driver inputs where practical. Accepted configuration is not warm readiness.

The proxy reads an already-warm token scoped to the binding and operation. Cold or expired reads return `NotReady`; requests never mint, refresh, or schedule refresh. Tokens are keyed by source generation, normalized grant, and isolation boundary; narrow grants cannot borrow broader tokens. V1 has no dynamic-token push or proxy-side dynamic-token cache.

Each rotating family needs one fenced refresher **before consuming rotating input**, and durable replacement state before readiness. Timeout does not settle upstream refresh: reconcile a lost response with the provider or require reauthorization; never blindly replay it.

On warm-token rejection, return the failure without automatic retry and send authenticated feedback naming the exact source configuration, grant, and token version. Provider-specific classification distinguishes credential rejection from other failures. Token Service refreshes or marks the source unhealthy in the background; late rejection of N cannot invalidate N+1. Response policy still applies.

## Examples and startup

**Static inference:** An owner registers a source, grants use to the caller and Agent principal, lists it in `credentialSources`, and selects it with `harnessAuth`. The proxy resolves, obtains the final check, injects, and forwards. Unavailable authority refuses the operation even with cached material.

**Optional GitHub bootstrap:** Token Service warms an installation token for the admitted grant before trusted bootstrap clones through authorized egress. Required credentials have a bounded readiness wait. Failed or uncertain clone blocks startup by default; custom setup may opt out of that gate, not authorization. Compute/bootstrap owns partial-workspace cleanup. [Lifecycle details](lifecycle.md#2-prepare-the-optional-repository) define validation and unresolved interfaces.

## Delivery and verification

After architecture review, bounded implementation can begin through the contracts above; this does not establish a qualified hardened rollout. The owner must select milestones without narrowing overall V1 scope by implication. A separate implementation plan should record delivery and proof.

| Remaining work           | Questions or evidence                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope decisions          | Native IAM only or external authorization implementations too? Which bounded milestone comes first?                                                                                                                                                                  |
| Implementation discovery | Deadline values/time protocol and transport enforcement; execution identity; bootstrap delegation/completion; durable refresh store/fencing; adapter placement; Secret version/age evidence and cutover.                                                             |
| Qualification            | Connected static inference, GitHub preclone, Codex OAuth, and custom dynamic paths; cross-Agent/cross-Namespace denial, revocation races/partitions, bypass/protocol enforcement, rotation/cache bounds, background refresh, bounded startup, and uncertain cleanup. |

Codex remains `0.160.0`. The [companion](lifecycle.md#implementation-discovery-and-qualification) records source-based adapter limits, provider questions, and qualification work. Source review, installed runtime evidence, and live-provider evidence remain distinct; fixtures do not establish enforcement. Workload-token verification and identity exchange remain deferred. Deployment acceptance does not establish warm credentials or Agent readiness.

## Appendix: failure and recovery

These requirements apply to every supported operation.

| Boundary    | Required handling                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authority   | Never cache allows. Deny new operations when OCC/current authority is unavailable, including cache hits. Expand scope only after required dynamic material is prepared and authority rechecked; narrower access may continue meanwhile. Reductions apply to subsequent checks without waiting for replacement, subject to the accepted race.                 |
| Forwarding  | Prevent bypass; bind policy to actual destination and protocol authority; strip Agent authentication; keep credentials out of Agent files and diagnostics.                                                                                                                                                                                                   |
| Responses   | Apply trusted provider-specific policy; pass through only where permitted, otherwise redact or refuse. Providers that may return credentials cannot use unchecked pass-through. Refuse if required handling cannot cover headers, body, trailers, encoding, or streams.                                                                                      |
| Protocols   | Deny opaque SSH, database, and other traffic without authorizable individual operations. Deferred UDP/QUIC cannot bypass enforcement. Future support needs protocol-specific boundaries, capabilities, and enforcement proof; DNS needs its own design.                                                                                                      |
| Rotation    | Establish replacement visibility/adoption by every serving proxy and settle old-key in-flight use before ordinary retirement; emergency revocation may precede it.                                                                                                                                                                                           |
| Uncertainty | Distinguish pre-send refusal, known/blocked response, provider rejection, and possible dispatch. Never automatically resend uncertain dispatch; reconcile before replay. Retain original owner, deadline, and cleanup obligations for uncertain sends, refreshes, and clones. Restored configuration is not warm readiness.                                  |
| Owner loss  | Confirmed last-owner loss in OCE triggers a hold and asynchronous parking, protecting retained data and blocking new execution subject to the race. Unknown state is not confirmed loss; remaining team owners prevent parking solely for one departure. Report incomplete containment; release requires authorization.                                      |
| Forks       | An authorized deep copy of readable content has independent storage, fresh identity, and starts stopped without inherited credentials, grants, approvals, or sessions. Automation stays inert until admitted. [Parking and forks](lifecycle.md#parking-and-forks) defines preservation and copy rules. IdP synchronization and copy-on-write are later work. |
