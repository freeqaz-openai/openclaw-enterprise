# Workspace launcher

Open `/console/launch` to reach your assigned Claw. After the existing sign-in,
OCE opens the only available destination automatically. If you have multiple
destinations, choose one by name. **Fleet administration** appears only with
Installation `administer`; it does not imply access to every Agent. Claws require
readable Namespace/Agent discovery and exact Agent `administer` permission.

Signing in at `/console/login` without a valid return destination also opens the
launcher. This includes signing back in after **Sign out**. An explicit supported
console return path still opens that page after authentication.

An assigned workspace that is stopped, disabled, unsupported, or unavailable
stays visible without an open link. Use **Refresh availability** to check again.
A failed discovery offers **Try again**, not a partial list or an automatic
redirect. **No access assigned** means discovery completed without any permitted
destinations; contact your administrator. Availability describes native UI
configuration and revision state, not a live gateway health probe.

Use **Switch destination** in the console account menu to return to
`/console/launch?choose=1` without automatic navigation. Existing `/console/`
and resource deep links retain their meaning. Operators can point their entry
URL at `/console/launch` after verifying it in their environment; the controller
does not reconfigure an external ingress redirect.

The launcher uses the current session and permission APIs without a separate
permission store, saved default, or service credential. It does not grant access
or change an external access gateway's sign-in policy. A native-host document
visit without a valid session returns through the canonical console login and
then rechecks the exact Agent; API/WebSocket denial behavior remains unchanged.

## Visual review

The **Pages/Launcher** Storybook group covers sign-in, chooser, unavailable, empty,
error, and loading states. Use example credentials only; the native destination
is simulated. Browser tests separately exercise the real session and IAM APIs.

For shared-session requirements, see [Agent native administration](../agent-native-admin.md).
For administration, see the [platform console](../console.md).
