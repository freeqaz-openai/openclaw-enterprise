---
rfc: index.md
---

# Proposed credential lifecycle

These phases expand the [RFC](index.md). They describe proposed responsibilities,
not selected wire APIs, physical processes, or qualified runtime behavior.

## 1. Configure and warm

![Proposed configuration and warmup](assets/configuration-warmup.svg)

_Proposed phase. [Editable source](assets/configuration-warmup.mmd)._

An authorized owner configures sources and Agent bindings. OCC admits their routes
and grants, then gives Token Service the approved dynamic configuration. The
service obtains static signing or refresh inputs and prepares tokens in the
background, even without requests. Accepted configuration is not warm readiness.
A required token that does not become ready within the configured bound blocks
startup and reports status. Each rotating family has one fenced refresher before
consuming rotating input and durable replacement state before readiness.

### Live Secret cutover

Live adoption is selected: static sources reread their configured Secret reference.
Today, the [credential-source workflow](../../../docs/reference/credential-sources.md#update-a-source)
registers a copy, requires a source update to refresh it, and requires redeployment
for running Agents to use the replacement. The proposed resolver changes both the
read path and who can cause a running Agent's credential to change.

Admission must authorize continuing reads of the selected reference. Permission
to change that Secret can then change material used by its admitted consumers
without another source-update admission. Value changes preserve configuration
generation; switching references or configuration still requires admission.

Implementation must map existing attachments and gateway copies to admitted
references, define how running revisions cut over, and expose adoption before
ordinary old-value retirement. Validate replacement attachments before stopping
a working Agent. Source-use permission removal must not prevent accepted cleanup.
Cutover mechanics and read/version/age evidence remain open; existing Agents must
not be described as already using live reads. This transition does not require a
permanent compatibility path.

## 2. Prepare the optional repository

![Proposed optional clone gate](assets/clone-startup.svg)

_Proposed phase; dashed edges show proposed interactions.
[Editable source](assets/clone-startup.mmd)._

1. **Owner and OCC:** Admit the configured repository and its grant, including
   repository IDs and permissions. Repositories remain optional and first-class.
2. **Token Service and provider adapter:** Before clone, sign an App JWT with the
   GitHub App private key and exchange it for an installation token. Validate
   returned authority against the exact normalized grant, including
   provider-required baseline permissions, and check expiry. The private key,
   App JWT, and installation token have distinct roles. Required material must
   become warm within the startup timeout.
3. **Trusted bootstrap:** Receive authority limited to the Agent execution and
   configured repository. Each clone operation passes through the proxy and OCC.
4. **Compute:** Start the Agent after observed successful preparation. Failed or
   uncertain clone blocks startup by default; a custom opt-out changes the gate,
   not authorization. Compute/bootstrap retains partial-workspace cleanup.

Bootstrap delegation and proof of clone completion remain open interfaces. Removing
Repo Driver as a separate implementation requires explicit owners for discovery,
profiles, grants, sessions, deadlines, and cleanup; revision selection and setup
are later work.

Agent owners see provisioning and credential readiness or failure and receive
notice when use is threatened. Platform operators see refresh failures and
approaching expiry. Alert channels and thresholds remain open.

## 3. Resolve and forward

![Proposed credentialed request and credential selection](assets/request-caching.svg)

_Proposed credentialed request. [Editable source](assets/request-caching.mmd)._

The [six-step request path](index.md#authorization-and-forwarding) applies to every
supported operation. The proxy authenticates the execution, captures the operation,
selects an admitted route/binding, and checks authority. The shared resolver then
reads static material or an already-warm dynamic token; cold or expired dynamic
reads return `NotReady` without minting, refreshing, or scheduling work.

After transformations and awaited preparation, the sender obtains the final OCC
check for the exact immutable operation, execution, versioned route, grant, and
selected nonsecret material identity/version. Credential-free egress explicitly
records no material. Credential bytes never go to policy. A changed route or grant
requires re-admission and repeated checks.

The sender enforces the short send-start deadline and original absolute operation
deadline. Values, time protocol, and transport enforcement remain open. Authority
partition, denial, or unusable material refuses the operation. Provider responses
follow trusted provider-specific policy, including failures and streams.

## 4. Withdraw and recover

![Proposed withdrawal and recovery](assets/revocation-recovery.svg)

_Proposed phase. [Editable source](assets/revocation-recovery.mmd)._

A check that sees a committed withdrawal denies removed access. A check that races
withdrawal may still permit a send. An underway finite operation may continue until
its original deadline; cancellation is best effort and a local timeout does not
prove provider cancellation. Uncertain effects and cleanup remain with their
original owner and deadline. Stopping or replacing a local process does not prove
an upstream effect settled. Establish replacement adoption by every serving proxy
and settle old-key use before ordinary retirement; emergency revocation may come
first. Restoring Token Service configuration does not prove warm readiness.

## Parking and forks

When an operator disables or removes an owner in OCE, confirmed loss of the
last authorized owner installs a hold and execution fence for new admissions,
subject to the RFC's V1 check-to-send race. A team Agent with remaining owners
does not park solely because one leaves. Report incomplete containment.
Synchronizing external identity-provider offboarding is later work.

Ordinary deployment, restart, repair, deletion, and garbage collection cannot
bypass the hold or remove protected data. Parking is asynchronous: report
`parking` until required stop and preservation evidence supports `parked`.
Unknown owner or directory state is not confirmed owner loss. Platform-owned
cleanup continues for the exact accepted work even if its requester loses access;
hold release requires current authorization and a fresh execution admission.

An authorized reader may fork the declared readable artifact set from an
immutable captured version. Recheck source-read and destination-create authority
before making the fork visible. The fork is a deep copy with independent application
data and mutable references, a fresh stopped identity and runtime home, and no
inherited credentials, grants, approvals, or sessions. Copied schedules, hooks,
and pending work remain inert until explicitly admitted. The original remains
available for authorized read-only review. Copy-on-write, stronger stream
revocation, and deeper incident-preservation mechanisms need separate designs.

## Implementation discovery and qualification

These questions guide implementation after architecture review; they do not select
a first milestone or reduce V1 scope. The [main RFC](index.md#delivery-and-verification)
keeps scope decisions separate from implementation discovery and qualification.

| Interface or integration | Open work                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenShell composition    | Which logical contracts can one adapter satisfy, and where are OCE-owned components or upstream hooks needed?                                                                        |
| Secret reads             | Demonstrate live reads, typed failure classification, nonsecret material versions, and trustworthy authoritative ages across every serving cache, including external Secret changes. |
| Dynamic custody          | Select the durable refresh store and fencing mechanism for each rotating family.                                                                                                     |
| Execution and bootstrap  | Specify execution identity binding, issuance, credential delivery/lifetime, limited bootstrap delegation, and completion evidence.                                                   |
| Provider integration     | Determine exact GitHub permissions/repository mapping and how Codex obtains account metadata and reconnects without a provider credential in the workload.                           |
| Operations               | Select alert channels and thresholds for owners and platform operators.                                                                                                              |

The inspected OpenShell [middleware](https://github.com/NVIDIA/OpenShell/blob/6144a7beb92e32e1fd41c798aec7aaf6d9ff0b29/crates/openshell-supervisor-network/src/l7/relay.rs#L1981-L2108)
precedes credential preparation; its [token-grant miss](https://github.com/NVIDIA/OpenShell/blob/6144a7beb92e32e1fd41c798aec7aaf6d9ff0b29/crates/openshell-supervisor-network/src/token_grant.rs#L247-L286)
can issue a token. Neither establishes the final online check or a warm-only read.
Qualification must prove those contracts at the actual adapter boundaries.

Dedicated Codex normally uses a [Responses WebSocket](../../../docs/reference/harness-execution.md).
The [pinned 0.160.0 source](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client.rs#L1918-L1925)
supports HTTP/SSE fallback on an initial `426` handshake. That source branch does
not qualify the OCE/OpenShell path. Codex remains at `0.160.0`; the HTTP/SSE path
and OpenShell's final check after preparation and before send still need proof.

Reconcile the earlier [Token Service proposal](https://github.com/openclaw/openclaw-enterprise/pull/924),
which differs on renewal, execution identity, custody, and startup readiness,
before treating it as superseded. [#1559](https://github.com/openclaw/openclaw-enterprise/pull/1559)
proposes a Codex receiver, not the supplier.

Bounded contract work can cover admission, forwarding, explicit results, static
value age, and background dynamic readiness. A hardened rollout still needs the
connected provider/runtime scenarios and failure evidence in the main RFC.
Source review, fixtures, installed runtime checks, and live-provider checks prove
different things; a local model or no-op adapter does not prove enforcement.

Related architecture: [Credential Gateway Driver RFC](../0016-sandbox-credential-injection.md)
and [Agent egress RFC](../0017-agent-egress-0x/index.md).
