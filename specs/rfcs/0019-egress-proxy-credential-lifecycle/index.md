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

Agents need providers without managing credentials. Credential use, renewal and deployment are coupled: the [static workflow](../../../docs/reference/credential-sources.md#update-a-source) copies a value, so replacement requires a source update and redeployment. Trusted discovery also needs provider access without an Agent.

This RFC separates authorization, credential resolution and lifecycle. A trusted sender mediates or denies every Agent egress operation, checks authority and injects credentials outside the Agent. Static sources adopt Secret changes; a lifecycle owner prepares dynamic credentials. Different backends and custody choices can implement these roles. OpenShell is a candidate; this composition is not implemented or qualified. The contracts guide implementation without fixing wire formats.

![Proposed logical credential path](assets/overview.svg)

_Dashed arrows are proposed. Authenticated bootstrap and discovery need not use an Agent's proxy. [Editable diagram](assets/overview.mmd); [lifecycle details](lifecycle.md)._

## Roles and deployment

OpenClaw Control Plane (OCC) admits configuration and decides authority. An adapter may implement several logical roles.

| Role                            | Responsibility                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------- |
| OCC                             | Admit sources, bindings, routes and grants; check authority.                    |
| Egress Proxy / trusted sender   | Capture, resolve, inject, send and protect responses.                           |
| CredentialResolver              | Select static material or a scoped warm token; resolution is not authorization. |
| Secret Driver                   | Read static values and lifecycle inputs with age and error evidence.            |
| Token Service / lifecycle owner | Prepare, renew and recover dynamic credentials; report readiness.               |
| Provider issuer                 | Issue material; validate returned scope and expiry.                             |
| Compute / bootstrap             | Prepare repositories; clean up partial workspaces.                              |

Custody may be OCE-managed or delegated; each family has exactly one lifecycle owner. Source policy must permit material at the trusted sender; routes cannot narrow a stolen bearer. The Egress Proxy Driver configures and observes enforcement; the Credential Gateway Driver registers sources and attaches revisions. The Agent's OpenClaw Gateway is separate.

| Caller                  | Identity and authority                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent execution         | A stable Namespace-scoped ServicePrincipal identifies the Agent; a separate MVP execution bearer authenticates its run. It receives responses or placeholders, never provider material or handles. |
| Trusted bootstrap       | Delegation is authenticated and limited to the execution and configured repository.                                                                                                                |
| Control-plane discovery | A service identity is authorized for the exact source, purpose, scope and destination, with initiating-user rights where applicable. Results are sanitized; discovery gets no refresh roots.       |

[Discovery](lifecycle.md#3-resolve-and-forward) uses a bounded trusted callback or sender and checks each send. Its interface, bootstrap delegation and execution identity issuance and lifetime remain open. Fixtures and no-op egress do not prove enforcement; hardened deployments require enforcement without no-op fallback.

## Authorization and forwarding

For every supported operation, including credential-free egress:

1. The sender authenticates the caller, captures the immutable operation, destination, protocol authority and policy-relevant content, and selects an admitted route and grant. Credentialed operations also need a binding. Ambiguity, unsupported operations or insufficient scope are refused.
2. OCC checks current authority online over the caller, versioned route, grant and operation before material access. Each Agent needs authorization to use a binding, even for a shared source.
3. When needed, the resolver returns a use-bound, single-use handle to trusted code, or `Denied`, `NotReady` or `Unavailable`. A handle is not permission to send.
4. After transformations and awaited preparation, OCC freshly checks the actual immutable operation, caller, versioned route, grant and nonsecret material identity/version, or explicit material absence. Changed routes or grants require re-admission and repeated checks.
5. The sender rechecks usability, injects material, sends once and applies response policy. Each HTTP subrequest, redirect, retry or new operation, including on a reused connection, repeats checks and required resolution. Authority or resolution failure denies use; cached allows are forbidden.

Context comes from the authenticated boundary; policy receives no credential bytes. A send cannot substitute another operation or material. Handles guard trusted-call mistakes, not hostile code in the same process.

**Accepted race:** A final check can race a committed reduction or hold, allowing a send to start after acknowledgment. A check that observes withdrawal denies removed access. The sender enforces a finite short send-start deadline and the original absolute operation deadline, which retries cannot extend. Cancellation is best effort; a local timeout neither proves remote cancellation nor undoes effects. Ordered admission and renewable stream leases are follow-up work.

## Credential resolution

### Declarative configuration and request APIs

Operators declare an **Agent binding → source → backend → provider**, with an approved grant. OCC admits the identities, configuration generations and scope. This example is conceptual, not a resource schema:

```yaml
backends:
  primary: { driver: openshell }
credentialSources:
  company-github: { backendRef: primary, kind: github-app/v1, providerRef: provider-uuid }
agentBindings:
  repo-reader:
    agentRef: build-agent
    sourceRef: company-github
    grant: { repositoryIds: ["123"], permissions: { contents: read } }
```

The provider adapter classifies the operation against the normalized grant, including repository ID and action. Requests cannot choose another source or backend, load a driver or widen scope. Material versions change independently of configuration generations.

Three conceptual trusted seams: `egress.forRequest(request).forward(bindingRef)` owns capture, checks, resolution, injection, send and response handling; `resolve` takes the admitted binding and operation context and returns a use-bound handle or refusal; `authorizer.check` decides authority over caller, route, grant, operation and, at the final check, material identity/version or absence. These proposed seams expose no credential reads to Agents. For static inference, an owner registers and grants a source, lists it in `credentialSources` and selects it with `harnessAuth`; the same checks apply.

### Static credentials

An admitted static source reads its Secret reference and adopts value changes without Agent redeployment. Admission authorizes continuing reads, so a Secret writer can change material used by admitted consumers. Reference or configuration changes require admission; failed changes preserve the previous configuration.

The proposed per-source freshness default is **10 minutes**. Only a typed, eligible temporary store failure permits stale use, up to **four hours total authoritative age**, with trustworthy age evidence across serving layers. Denial, known revocation, missing material, unknown error or unavailable authority fails closed. Zero cache period disables reusable retention and stale fallback everywhere. [Cutover details](lifecycle.md#live-secret-cutover) cover cold reads and adoption before retirement.

### Dynamic credentials

The lifecycle owner prepares and renews material in the background, even when idle. The resolver is called for every credentialed operation; scoped warm tokens may be reused behind it. Cold or expired material returns `NotReady`; a read never triggers issuance, JWT minting, refresh or scheduling. There is no dynamic-token push, reusable proxy cache or fallback, and static stale grace does not apply. An issuer outage alone need not prevent a healthy resolver serving eligible unexpired material; resolver failure denies use.

Routine renewal must not interrupt use or restart the proxy or Agent; unusable credentials fail closed. Exceptional reauthorization may visibly interrupt the affected credential; planned hot cutover is later work. [Recovery](lifecycle.md#4-withdraw-and-recover) covers fencing, durable replacement and uncertain effects.

## Examples and startup

Repositories are optional. When configured, OCC admits the repository and grant; required credentials must warm within a bounded wait. Trusted bootstrap performs an authorized clone, whose observed completion gates startup by default. A custom opt-out changes the gate, not authorization. Compute/bootstrap owns partial and uncertain work; existing Repo Driver duties remain assigned until explicitly changed. [Startup details](lifecycle.md#2-prepare-the-optional-repository).

## Delivery and verification

The Egress Proxy MVP can precede rotating OAuth and must qualify its declared initial slice. Complete OCE 1.0 requires static inference, GitHub, Codex OAuth and custom dynamic paths, including safe rotating inputs. Investigate a GitHub issuer bridge; native upstream support is optional and an OCE-owned warm lifecycle remains an alternative. [#1691](https://github.com/openclaw/openclaw-enterprise/pull/1691) proposes narrower refresh composition, not these per-operation checks. External authorization's relationship to native IAM remains open.

[Qualification](lifecycle.md#implementation-discovery-and-qualification) covers provider paths, isolation, enforcement, rotation, startup and recovery. Source, fixtures, installed runtime and live-provider evidence differ; deployment acceptance is not warm or Agent readiness. DNS and the pinned Codex `0.160.0` HTTP/SSE integration remain open; no upgrade is selected.

### Earlier Token Service proposal

This RFC retains issuer, grant, discovery and recovery requirements from [PR #924](https://github.com/openclaw/openclaw-enterprise/pull/924), with a different lifecycle model. See the [disposition and historical design](lifecycle.md#earlier-token-service-proposal).

## Appendix: failure and recovery

| Boundary                 | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority                | Deny when current authority is unavailable, even for cached material. Scope expansion waits for required warm material and a fresh check; narrower access may continue. Reductions apply to subsequent checks, subject to the accepted race.                                                                                                                                                                                       |
| Trust and responses      | Prevent bypass; bind destination and protocol authority; strip Agent authentication; keep provider credentials out of workloads, files and diagnostics. Provider-specific policy must safely pass, redact or refuse headers, bodies, trailers, encodings and streams. A blocked response does not prove no upstream effect.                                                                                                        |
| Protocols                | Deny opaque SSH, database and other traffic without individually authorizable operations. UDP/QUIC cannot bypass enforcement; further protocols need explicit boundaries and proof.                                                                                                                                                                                                                                                |
| Rotation and uncertainty | Fence before consuming rotating input; persist replacement before readiness. Ordinary retirement waits for every serving proxy's adoption and settlement of old-key in-flight use; emergency revocation may precede it. Reconcile uncertain sends, refreshes and clones without blind replay; preserve owner, deadline and cleanup duties.                                                                                         |
| Owner loss and forks     | Confirmed last-owner loss triggers a hold and asynchronous parking, subject to the race; unknown is not confirmation and remaining team owners matter. Preserve data and accepted cleanup. An authorized deep fork has independent storage and a fresh stopped identity, without inherited credentials, grants, approvals or sessions; automation stays inert until admitted. [Parking and forks](lifecycle.md#parking-and-forks). |

Identity-provider synchronization, copy-on-write, stronger stream revocation, proxy fallback, horizontal proxy HA, mTLS identity, workload-token verification and identity exchange need separate work.
