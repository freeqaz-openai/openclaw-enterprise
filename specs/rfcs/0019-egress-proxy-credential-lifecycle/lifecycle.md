---
rfc: index.md
---

# Proposed credential lifecycle

These phases expand the [RFC](index.md). They describe proposed responsibilities, not selected wire APIs, required physical processes or qualified runtime behavior.

## 1. Configure and warm

![Proposed configuration and warmup](assets/configuration-warmup.svg)

_Proposed background preparation. Participants are logical roles; solid arrows
are calls and dashed arrows are returns, not implementation status. OpenShell
#4357 supplies shared refresh coordination and a marker before issuer access;
the complete composition still needs integration and qualification.
[Editable source](assets/configuration-warmup.mmd)._

An authorized owner configures sources and bindings. OCC admits routes and
normalized grants, then supplies dynamic configuration to its lifecycle owner.
The owner prepares credentials in the background, even without requests, and
reports readiness or failure. Accepted configuration is not warm readiness. If a
required credential does not become warm within the configured bound, startup
is blocked and status is reported.

The Secret Driver can read a static value or an issuer's signing or refresh
input; this does not make it a second lifecycle owner. A rotating family has one
refresher, fenced before input consumption, and durable replacement state before
readiness. Once replacement input is canonical, rereading a bootstrap Secret
must not overwrite it. Renewal preserves admitted authority; the issuer
validates returned scope and expiry against the exact grant.

### Management preparation and retrieval

![Proposed authorized management preparation](assets/management-preparation.svg)

_Proposed configuration/discovery path. Solid arrows are calls and dashed arrows
are returns. The trusted management caller is also the provider sender; these
roles add no required service hop. It may request refresh through the designated
owner. Agent/bootstrap resolution remains warm-only.
[Editable source](assets/management-preparation.mmd)._

Explicitly authorized control-plane configuration or discovery may request
preparation or refresh through that same lifecycle owner, then use usable
material in authorized trusted code. Current authorization precedes access and
is checked again after preparation, before each provider send. Caller, source,
purpose, grant and destination remain bound as specified in
[security](security.md#callers-and-trust-boundaries). Retrieval exports no
signing or refresh roots, and provider tokens do not go to the Agent or UI.
Failure or material still unusable within the original deadline refuses use;
uncertain refresh effects remain owned and cannot be blindly replayed. An Agent
cannot select this path through a flag, and bootstrap delegation does not grant
it. Background warming continues independently, even when idle.

Merged [OpenShell #4357](https://github.com/NVIDIA/OpenShell/pull/4357) adds
operator-only `GetProviderCredentials`: it reuses sufficiently valid runtime
credentials or refreshes supported gateway-managed credentials to satisfy the
requested remaining lifetime. It excludes refresh roots and unsupported dynamic
grants. Retrieval may fail after refresh has taken effect. In the inspected
`dd1ac0c` source for open [OCE #1785](https://github.com/openclaw/openclaw-enterprise/pull/1785),
the [`withSourceToken` callback](https://github.com/openclaw/openclaw-enterprise/blob/dd1ac0ca8ec68c004cbc3c0049265d1e5df4a915/apps/controller/src/drivers/credential-gateway/openshell.ts#L657-L678)
uses that operator channel for trusted configuration. These management surfaces
do not implement the proposed warm-only request-path Resolver. OCE must still
connect its exact caller authorization, material evidence and custody requirements.

### Live Secret cutover

Static live adoption is selected. Today the [credential-source workflow](../../../docs/reference/credential-sources.md#update-a-source) copies a value on source update; running Agents need redeployment to use its replacement. Proposed admission authorizes continuing reads of the chosen reference. Its writer can change material used by admitted consumers without another source update; each operation still needs current authority. Value changes preserve configuration generation. A reference or configuration change needs admission, and a failed change preserves the previous configuration.

The proposed freshness default is 10 minutes per source. Eligible temporary
store errors permit stale use only up to four hours **total** since the last
trustworthy authoritative observation. Both limits are configurable per source.
For a value observed at 09:00, freshness ends at 09:10 and eligible fallback by
13:00. Failed reads and lower-cache hits do not reset age.

Typed eligible errors and trustworthy age are required across every serving
layer; generic unavailability is insufficient. Cold reads have no stale fallback.
Denial, known revocation, missing material, unknown errors or unavailable
authority fail closed. Zero cache period disables reusable retention and stale
fallback everywhere. Recheck usability at dispatch.

Implementation must map existing attachments and gateway copies to admitted references, define running-revision cutover, expose adoption, and validate replacement attachments before stopping a working Agent. Removal of source-use permission must not prevent accepted cleanup. Cutover mechanics and version/age evidence remain open; existing Agents do not yet use live reads.

## 2. Prepare the optional repository

![Proposed optional clone gate](assets/clone-startup.svg)

_Proposed default clone gate; dashed edges show proposed interactions. Bootstrap
uses its own authorized sender and warm-only Resolver, without management
preparation authority. Failed or uncertain clone blocks startup by default;
opting out of the gate does not waive authorization.
[Editable source](assets/clone-startup.mmd)._

1. The owner and OCC admit the configured repository and grant, including repository IDs and permissions. Repositories remain optional and first-class.
2. The lifecycle owner and provider issuer prepare a GitHub installation token in the background. The issuer signs an App JWT and exchanges it for the token; it validates returned authority against the exact normalized grant, including provider-required baseline permissions, and checks expiry. The private key, App JWT and installation token have distinct roles. Required material must warm within the startup bound.
3. Trusted bootstrap receives authenticated delegation limited to the execution and configured repository. Every clone operation uses authorized egress. This caller need not traverse the Agent's own proxy.
4. Compute starts the Agent after observed successful preparation. Failed or uncertain clone blocks startup by default; a custom opt-out changes the gate, not authorization. Compute/bootstrap owns partial-workspace cleanup and must not blindly replay an uncertain clone.

Delegation and proof of completion remain open interfaces. Repo Driver duties for
discovery, profiles, grants, sessions, deadlines and cleanup remain with their
current owners until explicitly reassigned. Revision selection and setup are later
work. Agent owners need provisioning and credential failure status and notice
when use is threatened; platform operators need visibility into refresh failures and approaching expiry. Alert channels and thresholds remain open.

The current Repo-plus-Sandbox restriction needs actual repository integration
and qualification before it can be lifted; deleting the guard alone is insufficient.

### GitHub issuer bridge

The preferred investigation keeps OpenShell as the background scheduler and
uses an OCE endpoint as the GitHub issuer. OpenShell's client-credentials path
can call a configured token endpoint. The proposed endpoint would authenticate
that caller, map it to the admitted source generation and GitHub grant, sign an
App JWT with the private key, and exchange it for an installation token. It
would validate the returned scope and expiry against the grant and return an
OAuth-shaped result. The hook supplies issuance; it is not another refresh loop.

Authenticated grant mapping and material identity, version and expiry evidence
need integration work. The inspected OpenShell OAuth response handling uses a
token and relative expiry; it does not preserve returned scope, material version
or absolute expiry. The bridge must return a conservative positive lifetime
within provider validity; a configured expiry fallback is not provider-expiry
evidence. Configuring an endpoint alone therefore does not establish a
conforming warm-only request-path Resolver. The bridge and its protocol are not implemented
by this proposal; an OCE-owned warm lifecycle remains an alternative. The final
lifecycle owner remains open.

## 3. Resolve and forward

![Proposed request authorization and resolution](assets/request-caching.svg)

_Proposed Agent or separately delegated bootstrap request, including
credential-free egress. Participants are logical roles; solid arrows are calls
and dashed arrows are returns. Cold dynamic lookup refuses without scheduling
preparation; authorized management uses the separate path above.
[Editable source](assets/request-caching.mmd)._

![Proposed final authorization and dispatch](assets/request-forwarding.svg)

_Continuation of the same proposed request: OCC check 2 binds the actual operation
and material before send. The sender then protects the response. Solid arrows
are calls and dashed arrows are returns; they do not indicate implementation.
[Editable source](assets/request-forwarding.mmd)._

![Proposed static and dynamic credential selection](assets/credential-selection.svg)

_Proposed Agent/bootstrap resolution; dashed edges show proposed connections.
Static stale use requires typed eligible errors and trustworthy age; four hours
is the total age limit. Zero cache disables retention and stale fallback.
Dynamic reuse stays behind the Resolver, with no proxy fallback or stale grace.
Full limits remain in [live Secret cutover](#live-secret-cutover).
[Editable source](assets/credential-selection.mmd)._

The request-path Resolver selects static or warm dynamic material for each
credentialed Agent or bootstrap operation. A cold or expired dynamic read returns
`NotReady` without issuing, refreshing or scheduling. An issuer outage can coexist
with an eligible warm token; Resolver failure denies use.
[Authorization and custody](security.md#authorize-each-operation) define the
checks, scoped reuse, discovery and response handling.

## 4. Withdraw and recover

![Proposed withdrawal and recovery](assets/revocation-recovery.svg)

_Proposed withdrawal with the accepted check-to-send race. Solid arrows are calls
and dashed arrows are returns; work ownership survives process replacement.
The responsible owner is the owner of each send, refresh or clone. Separate
rejection feedback goes to the lifecycle owner, without an automatic sender retry.
[Editable source](assets/revocation-recovery.mmd)._

A check observing a committed withdrawal denies removed access, subject to
the [accepted race and deadlines](security.md#withdrawal-and-owner-loss).

On a warm-token rejection, return failure without automatic retry. Authenticated
feedback identifies the source configuration generation, grant and token
version; provider-specific classification distinguishes credential rejection
from other failures. The lifecycle owner refreshes or marks the source unhealthy
in the background. A late rejection of version N cannot invalidate N+1.

Fence competing refreshers **before** consuming rotating input, and persist
replacement input before reporting readiness. A timeout, process exit or generic
family status does not settle an uncertain provider effect. Reconcile it with
the provider or require reauthorization; do not blindly replay a send, refresh or
clone. Preserve the original owner, deadline, nonsecret attempt evidence and
cleanup duties after process replacement, including late outcomes. Cleanup may
remain owed after use ends. Restored configuration is not warm readiness.

Ordinary renewal must not require a proxy or Agent restart or periodically
interrupt use. Exceptional reauthorization may visibly interrupt the affected
credential while retaining fail-closed behavior. Establish replacement visibility
and adoption by every serving proxy and settle old-key in-flight use before
ordinary retirement; emergency revocation may come first. Planned hot cutover is
separate work.

## Parking and forks

The security model defines the [hold and parking requirements](security.md#withdrawal-and-owner-loss)
and the [authorized deep fork](security.md#authorized-forks). External
identity-provider synchronization, copy-on-write and stronger stream revocation
remain separate work.

## Earlier Token Service proposal

[PR #924](https://github.com/openclaw/openclaw-enterprise/pull/924) supplied issuer metadata, normalized grants and scope/expiry validation; distinct issuer and consumer duties; and discovery, uncertainty and cleanup requirements. This RFC retains those requirements with one lifecycle owner; [#1691](https://github.com/openclaw/openclaw-enterprise/pull/1691) describes narrower refresh composition.

Background preparation and warm-only request-path reads replace
Agent-demand-driven issuance. Separately authorized management preparation may
refresh through the designated owner. Central or delegated custody replaces a
fixed OCC topology; rotating refresh inputs need durable replacement, not the
earlier memory-only restriction. The MVP uses a separate execution bearer, while
its issuance, binding, delivery and lifetime remain open; it does not adopt an
indefinite Agent bearer. Required readiness and the default clone gate remain in
force.

Standalone operation, packaging, specific recovery exceptions, and Git-hook or `pushRefAllowlist` removal remain historical or separate work, not automatically implemented or adopted. The [original design](https://github.com/openclaw/openclaw-enterprise/tree/55e261623e6ba879eab1e2d27daa309d571a994a/specs/rfcs/0056-token-service) remains available for its rationale. Neither proposal is thereby accepted or runtime-qualified.

## Implementation discovery and qualification

These choices guide implementation; they do not weaken the selected contracts or require every wire detail to be decided before bounded work starts.

| Area                       | Open work or required evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenShell composition      | First composition to implement and qualify. The networking facet of `SandboxDriver` enforces the network boundary; `CredentialGatewayDriver` manages sources and attachments; merged [#1749](https://github.com/openclaw/openclaw-enterprise/pull/1749) adds `CredentialRefreshDriver` configuration for lifecycle ownership. Integrate runtime identity, both OCC checks, warm-only resolution, injection and response protection. |
| Management retrieval       | #4357 supplies operator retrieval; #1785 remains open, with source inspected at `dd1ac0c`. Bind OCE configuration/discovery authority and final material evidence; do not route Agent or bootstrap lookups through refresh-capable retrieval.                                                                                                                                                                                       |
| Secret and dynamic custody | Prove live reads, typed eligible errors and trustworthy version/age across caches. Current Secret results do not supply that evidence. #1749 keeps roots off Gateway registration; generic admitted custody policy remains proposed. Qualify rotating-input persistence and fencing.                                                                                                                                                |
| Identity and bootstrap     | Specify execution identity issuance, binding, delivery and lifetime; limited bootstrap delegation; clone completion and cleanup evidence.                                                                                                                                                                                                                                                                                           |
| Provider integration       | Investigate the [GitHub issuer bridge](#github-issuer-bridge); native upstream support is optional. Determine Codex account metadata and reconnect without placing provider credentials in the workload.                                                                                                                                                                                                                            |
| Operations                 | Select alert channels, expiry margins, deadline values, time protocol and transport enforcement. DNS needs its own design.                                                                                                                                                                                                                                                                                                          |
| Independent backends       | Follow-up RFCs for non-OpenShell and strong local-development compositions, packaging, additional Driver/Backend loading, version/capability compatibility and rejection of unsupported combinations. Existing Kubernetes, paired-Backend and Repo/Sandbox guards remain adapter constraints until replacement integration is supported.                                                                                            |
| Scale and HA               | Separate follow-up for state ownership, fencing, failover and measured availability; a composable contract or additional replicas do not establish qualification.                                                                                                                                                                                                                                                                   |

At the inspected #1749 source, [installed package loading](https://github.com/openclaw/openclaw-enterprise/blob/1c6ac12fb7a68213469ff9f43fe5e93588410d2c/apps/controller/src/composition/driver-packages.ts)
supports configuration, IAM, Compute and Sandbox Drivers. Framework registration
of another conforming Driver does not make credential Drivers or arbitrary
Backends loadable in an installation.

At merged OpenShell #4357 (`4c1b16a4`), the
[shared refresh path](https://github.com/NVIDIA/OpenShell/blob/4c1b16a4a104581fb0afe8675feff34f00cc2ca8/crates/openshell-server/src/provider_refresh.rs#L984-L1174)
coordinates scheduled, forced and retrieval-triggered refresh with local and
distributed locks, a state recheck and an uncertainty marker before issuer
access. Installed concurrency, restart, partitions and uncertain-outcome
recovery still need proof. In particular, settling a failed operation requires
attempt-correlated evidence; generic family status is insufficient. The
[retrieval source](https://github.com/NVIDIA/OpenShell/blob/4c1b16a4a104581fb0afe8675feff34f00cc2ca8/crates/openshell-server/src/grpc/provider_credentials.rs#L142-L386)
can refresh and supplies neither OCE's final online check nor a warm-only
request-path lookup.

Earlier [#1559](https://github.com/openclaw/openclaw-enterprise/pull/1559)
proposed a trusted discovery receiver. The inspected #1785 management callback
may refresh, as described above. Neither establishes a qualified request-path
Resolver. Dedicated Codex normally uses a
[Responses WebSocket](../../../docs/reference/harness-execution.md). The
[pinned 0.160.0 source](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client.rs#L1918-L1925)
supports HTTP/SSE fallback on an initial `426` handshake; this does not qualify
the composed OCE/OpenShell path. Discovery, fallback and final checks require
connected proof.

A hardened Egress Proxy MVP rollout must qualify its declared initial provider slice with actual enforcement, including isolation, revocation and partitions, protocol bypass, response handling, cache and renewal bounds, bounded startup and uncertain cleanup. OCE 1.0 must qualify the full static inference, GitHub preclone, Codex OAuth and custom dynamic paths, including safe rotating-input concurrency, restart and recovery. Any slice supporting rotating inputs must meet those safety requirements. Source inspection, fixture results, installed runtime and live-provider evidence establish different things; no-op adapters and deployment acceptance establish neither enforcement nor readiness.

Related architecture: [Credential Gateway Driver RFC](../0016-sandbox-credential-injection.md) and [Agent egress RFC](../0017-agent-egress-0x/index.md).
