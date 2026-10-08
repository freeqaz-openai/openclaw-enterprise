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

An Agent should use GitHub, an inference API, and other services without managing
provider credentials. OCE needs to decide which Agent may use each credential,
keep that credential current, and enforce the decision on outbound traffic.
Today those responsibilities are split across credential sources, runtime
refresh, repository preparation, and Sandbox behavior.

**Proposal:** define composable contracts for an **Egress Proxy**, credential
resolution, static Secret access, and dynamic Token Service. OpenClaw Control
Plane (OCC) owns current authorization; trusted data-plane senders enforce it
and forward to providers. One adapter may implement several contracts. OpenShell
is the V1 production candidate. V1 targets static sources, GitHub App, Codex
OAuth, and custom dynamic credentials.

This is a proposal, not a claim that the components are integrated or that
OpenShell already satisfies these contracts. The Agent's OpenClaw Gateway is a
separate component.

![Proposed logical credential path](assets/overview.svg)

_Proposed relationships; dashed arrows do not assert an implemented integration.
Roles need not be separate services. See the [editable diagram](assets/overview.mmd)
and [lifecycle phases](lifecycle.md)._

## Roles and composition

| Role                | Responsibility                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OCC                 | Admit sources and Agent bindings; maintain grants, execution identity, and current authorization.                                     |
| Egress Proxy        | Capture an outbound operation, enforce its admitted route, inject permitted material, and forward it.                                 |
| Credential resolver | Resolve one binding and its authorized use to static material or an already-warm dynamic token. The caller does not select a backend. |
| Secret Driver       | Read a referenced static credential or a Token Service input from its configured store.                                               |
| Token Service       | Prepare and refresh dynamic credentials in the background; expose readiness and warm-only reads.                                      |
| Compute / bootstrap | Prepare an optional repository before startup and own its completion and cleanup.                                                     |

An Egress Proxy Driver configures and observes the proxy. The existing
Credential Gateway Driver manages source registration and revision attachment;
it does not implement this proposed forwarding contract.

A deployment can use **central custody**, where an OCE-managed credential
runtime owns material and refresh, or **delegated custody**, where a conforming
adapter owns them. Both can coexist for different credential families. Each
rotating family has one canonical lifecycle owner. Permitted material may reach
a trusted data-plane sender outside the Agent workload; source custody policy
must allow that exposure. Restricting a route does not narrow a stolen provider
bearer.

Minimal CI can select no-op egress and fixtures; it must not claim production
enforcement. Local development can use that mode or exercise a production-style
adapter. A hardened deployment must require its selected enforcement capabilities
and must not fall back to no-op on failure.
Horizontal proxy HA and mTLS identity are later work.

**Open:** Which roles can one OpenShell adapter satisfy, and where does it need
an OCE-owned component or new upstream hooks?

## Authorization and forwarding

A source may be shared, but every Agent needs its own authorized binding and
identity. A binding identifies the source, configured backend, provider kind,
and approved scope; possession of a reference is not permission. The Agent's
existing Namespace-scoped ServicePrincipal is its stable identity. Its bearer
is distinct from provider credentials and must authenticate the current
execution. Issuance, delivery, lifetime, and bootstrap delegation remain open.

For every supported outbound operation, including credential-free egress:

1. The trusted proxy identifies the execution, captures the actual destination
   and operation, and selects the exact admitted binding when needed.
2. It checks current authority before accessing material. If a credential is
   needed, it resolves the binding; otherwise it skips the material read.
   Ambiguous routes, unsupported operations, and insufficient scope fail
   closed; the request cannot select another backend or widen its grant.
3. After transformations and awaited preparation, the authenticated sender
   makes a fresh OCC check for the exact execution, versioned route, grant,
   material version when applicable, and immutable operation, including its
   destination and policy-relevant content. A successful check permits one
   send within its short start deadline. A redirect, retry, or new operation on
   a reused connection needs a new check; recovery cannot recreate permission
   to send.

V1 does not cache allows. If OCC or current authority is unavailable, the proxy
refuses new operations, including credential cache hits. A check can race with a
committed reduction or hold: an already-checked operation may still start after
revocation is acknowledged. This is in addition to the risk that a finite
operation already underway can continue until its original, enforced deadline.
Cancellation is best effort and cannot undo provider effects. Ordered admission
and renewable stream leases are follow-up work; external IdP offboarding can
also reach OCE later than the original event.

An approved scope expansion activates after any required dynamic material is
prepared and authority is rechecked; existing narrower access may continue.
A reduction updates the authority checked for subsequent operations without
waiting for old credentials to be replaced, subject to the race above.

**Open:** Should V1 use native IAM only, or also admit external implementations?
What start and operation-duration limits can each supported transport enforce?

The proxy must prevent direct bypass, bind policy to the actual destination and
protocol authority, and remove Agent authentication before forwarding. Provider
responses pass through by default, subject to a trusted provider-specific policy
that can redact or refuse responses. A provider that may return credentials
cannot use unchecked pass-through. If required handling cannot cover the
response's headers, body, trailers, encoding, or stream, refuse it. Do not put
credentials in Agent files or diagnostics.

V1 denies opaque SSH, database, and other traffic whose individual operations
cannot be authorized. UDP/QUIC may be deferred and must not bypass enforcement.
Future support needs protocol-specific operation boundaries, adapter
capabilities, and enforcement tests. DNS needs its own design.

**Open:** Dedicated Codex normally uses a
[Responses WebSocket](../../../docs/reference/harness-execution.md) for model
calls. Its [pinned release](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client.rs#L1918-L1925)
supports HTTP/SSE fallback on an initial `426` handshake. Can we qualify that
path, and can OpenShell perform the final online check after credential preparation
and before send?

## Credential resolution

The preferred trusted integration performs the whole operation, conceptually
`egress.forRequest(request).forward(binding)`. A lower-level resolver can serve
trusted adapters with `resolve(binding, authorizedUse)` for either static or
dynamic material. Resolution does not itself authorize a send. These are
logical interfaces, not selected wire APIs. Agent code uses normal clients or
placeholders; it does not obtain provider material.

### Static credentials

The Secret Driver reads the current value at the configured reference. Updating
that value does not require a source update or Agent redeploy. Changing the
reference or source configuration still requires admission; a failed update
leaves the previously admitted configuration in force. A configuration
generation is distinct from a Secret material version.

The proposed per-source default is **10 minutes fresh**, with stale fallback
only for an eligible temporary store failure and at most **four hours total
age**. A zero cache period disables reusable retention and fallback across
serving layers. Denial, known revocation, missing material, an unknown error, or
unavailable authority fails closed. Age starts at the last trustworthy
authoritative observation; failed reads and lower-cache hits do not reset it.
Fallback requires typed errors and trustworthy value-age evidence across all
cache layers. Recheck usability at dispatch.

**Open:** What read path and freshness evidence can each Secret Driver and
OpenShell implementation provide, including when an external Secret changes?

### Dynamic credentials

OCC pushes admitted configuration to Token Service, which prepares and refreshes
credentials even when no Agent is making requests. For each use the proxy asks
for an already-warm token scoped to the binding and operation. A cold or expired
lookup returns `NotReady`; it neither mints nor schedules a refresh. Prepared
tokens are keyed by source generation, normalized grant, and isolation
boundary, so a read grant cannot borrow a broader token. V1 has no dynamic-token
push to the proxy and no proxy-side dynamic-token cache.

Token Service uses the Secret Driver for long-lived inputs where practical.
It needs one fenced refresher per credential family before consuming a rotating
credential, and durable replacement state before reporting readiness. An owner
timeout alone does not settle an upstream refresh. If its response is lost,
reconcile with the provider or require reauthorization; do not blindly replay it.

If a provider rejects a warm token, the proxy returns the failure without an
automatic retry and sends authenticated feedback naming the exact source
configuration, grant, and token version. Provider-specific classification
distinguishes credential rejection from other failures. Token Service refreshes
or marks the source unhealthy in the background; a late rejection of version N
cannot invalidate N+1. Response policy still applies.

**Open:** Which store and fencing mechanism own each rotating family? How does
Codex obtain account metadata and reconnect without a provider credential in
the workload? The earlier [Token Service proposal](https://github.com/openclaw/openclaw-enterprise/pull/924)
has reusable contracts but differs on renewal, execution identity, custody, and
startup readiness. Reconcile it with this proposal before treating it as
superseded. [#1559](https://github.com/openclaw/openclaw-enterprise/pull/1559)
proposes a Codex receiver, not the Token Service supplier.

## Examples and startup

**Static inference:** an owner registers a source and grants both the caller and
Agent principal use. The owner lists it in `credentialSources` and selects it
with `harnessAuth`. On a request, the proxy resolves the key, obtains a final OCC
check, injects it, and forwards.

**GitHub bootstrap:** Token Service uses a GitHub App private key to sign an
App JWT and exchanges it for an installation token scoped to the admitted
repository IDs and permissions. The adapter validates the returned authority
against that exact normalized grant, including provider-required baseline
permissions, and checks expiry. For a configured repository, trusted bootstrap
uses the same authorized egress path to clone before the Agent starts. Required
dynamic credentials wait for readiness with a bounded timeout. A failed or
uncertain clone blocks startup by default; a custom setup may opt out of that
gate, but not authorization. Compute/bootstrap owns partial-workspace cleanup.

Repositories remain optional and first-class for now. Removing Repo Driver as a
separate implementation requires explicit owners for its existing discovery,
profiles, grants, sessions, deadlines, and cleanup; revision selection and
setup are later work.

The Agent owner sees provisioning and credential readiness or failure and is
notified when credential use is threatened. Platform operators see refresh
failures and approaching expiry so they can act before Agents lose access.
Initial alert channels and thresholds remain open.

**Open:** How is bootstrap authority delegated and how does Compute prove clone
completion? Which exact GitHub permissions and repository mapping does V1
support?

## Delivery and verification

[#851](https://github.com/openclaw/openclaw-enterprise/pull/851) supplies
credential-source and Agent-revision foundations, not the proposed proxy path,
warm-only refresh, dynamic rotation, or repository preclone. Workload-token
verification and identity exchange remain deferred; an accepted deployment
does not mean credentials are warm or an Agent is ready.
Integration must validate replacement attachments before stopping a working
Agent and let accepted cleanup finish after source-use permission is removed.
The inspected OpenShell [middleware](https://github.com/NVIDIA/OpenShell/blob/6144a7beb92e32e1fd41c798aec7aaf6d9ff0b29/crates/openshell-supervisor-network/src/l7/relay.rs#L1981-L2108)
precedes credential preparation, and its
[token-grant miss](https://github.com/NVIDIA/OpenShell/blob/6144a7beb92e32e1fd41c798aec7aaf6d9ff0b29/crates/openshell-supervisor-network/src/token_grant.rs#L247-L286)
can issue a token; neither establishes the final online check or a warm-only read.

Qualify the connected path with static inference, GitHub preclone, Codex OAuth,
and a custom dynamic type. Verify cross-Agent and cross-Namespace denial,
revocation races and partitions, protocol and bypass handling, rotation,
cache bounds, background refresh, bounded startup, and cleanup after uncertainty.
Source review, installed runtime evidence, and live-provider evidence are
distinct. See the existing [Credential Gateway Driver RFC](../0016-sandbox-credential-injection.md),
[Agent egress RFC](../0017-agent-egress-0x/index.md), and
[credential source contract](../../../docs/reference/credential-sources.md).

## Appendix: failure and recovery

- **Static rotation:** establish replacement visibility and adoption by every
  serving proxy, and resolve old-key in-flight use, before ordinary
  retirement. Emergency provider revocation may precede adoption.
- **Withdrawal:** checks that observe the reduction deny unauthorized operations,
  including cache hits. A check that races the reduction may still permit a send;
  an underway finite operation can run until its original deadline. Local
  cancellation does not prove upstream effects have stopped.
- **Restart or uncertainty:** a cold static read has no stale fallback; restored
  Token Service configuration is not warm readiness. Keep the original owner,
  deadline, and cleanup obligation for an uncertain send, refresh, or clone.
  Do not replay a potentially dispatched effect without reconciliation.
- **Agent offboarding:** when an operator disables or removes an owner in OCE,
  automatically park an Agent that loses its last authorized owner. A committed
  hold blocks new execution and protects retained data while parking proceeds
  asynchronously; the check-to-send race above still applies. IdP offboarding
  synchronization is later work. Unknown owner state is not confirmed owner loss.
  A team Agent with remaining owners does not park solely because one owner
  leaves. Report incomplete containment; only an authorized hold release can
  permit a new execution. An authorized fork copies readable content into
  independent storage, starts stopped with a fresh identity, and inherits no
  credentials or grants. Copied automation remains inert until admitted. See
  [parking and forks](lifecycle.md#parking-and-forks).
