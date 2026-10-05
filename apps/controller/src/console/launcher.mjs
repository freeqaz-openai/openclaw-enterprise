import { button, element } from "./dom.mjs";
import { panel, sorted } from "./shell.mjs";

const availability = {
  available: ["Available", "Your OpenClaw workspace"],
  disabled: ["Not enabled", "Browser access has not been enabled for this workspace."],
  stopped: ["Stopped", "Your workspace is stopped. Contact your administrator to start it."],
  unsupported: ["Not available", "This workspace is not configured for browser access."],
  unavailable: ["Unavailable", "Your workspace is temporarily unavailable. Try again shortly."],
};

function collection(value) {
  if (!Array.isArray(value)) {
    throw new Error("Invalid destination collection");
  }
  return value;
}

// URLs come only from the authenticated native-admin response, never a query parameter.
function nativeUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid native UI destination");
  }
  return url.href;
}

async function agentDestination(request, namespace, agent) {
  let access;
  try {
    access = await request(
      `/namespaces/${encodeURIComponent(namespace.id)}/agents/${encodeURIComponent(agent.id)}/native-admin`,
    );
  } catch (error) {
    if (error.status === 403) {
      return null;
    }
    // A missing resource or failed discovery may be a concurrent change. Retry the
    // complete list instead of treating it as an authoritative single destination.
    throw error;
  }
  if (!Object.hasOwn(availability, access?.status)) {
    throw new Error("Invalid native UI availability");
  }
  return {
    id: agent.id,
    namespaceId: namespace.id,
    namespaceName: namespace.name,
    name: agent.name,
    status: access.status,
    ...(access.status === "available" ? { url: nativeUrl(access.url) } : {}),
  };
}

async function destinations(request) {
  // The existing observability read requires Installation administer, not just read.
  // Do not reuse the console's session cache: the launcher rechecks on every visit.
  const [namespaces, admin] = await Promise.all([
    request("/namespaces").then(collection),
    request("/observability").then(
      () => true,
      (error) => {
        if (error.status === 403) {
          return false;
        }
        throw error;
      },
    ),
  ]);
  const result = [];
  // Bounded discovery avoids a request burst for installations with many Agents.
  for (const namespace of sorted(namespaces)) {
    const agents = collection(
      await request(`/namespaces/${encodeURIComponent(namespace.id)}/agents`),
    );
    for (const agent of sorted(agents)) {
      const destination = await agentDestination(request, namespace, agent);
      if (destination) {
        result.push(destination);
      }
    }
  }
  if (admin) {
    result.push({
      id: "administration",
      name: "Fleet administration",
      type: "administration",
      status: "available",
      url: "/console/namespaces",
    });
  }
  return result;
}

export async function renderLauncher(context) {
  const { app, request, session, url, isCurrent, retry, logout, choose } = context;
  const view = element("main", { className: "launcher-content" });
  const identity = element(
    "div",
    { className: "launcher-account" },
    element(
      "div",
      {},
      element("strong", {}, session.user.name),
      element("span", { className: "muted" }, session.user.email),
    ),
    button("Sign out", () => void logout()),
  );
  app.replaceChildren(
    element(
      "div",
      { className: "launcher" },
      element(
        "header",
        { className: "launcher-header" },
        element(
          "div",
          { className: "brand" },
          element("img", { src: "/console/oce-mascot.png", alt: "", width: "36", height: "36" }),
          "OpenClaw Enterprise",
        ),
        identity,
      ),
      view,
    ),
  );
  panel(view, "Finding your workspaces…", "Checking your current access.");
  try {
    const items = await destinations(request);
    if (!isCurrent()) {
      return;
    }
    const intendedAgent = url.searchParams.get("agent");
    const intendedNamespace = url.searchParams.get("namespace");
    let selected = null;
    if (url.searchParams.has("agent")) {
      // An explicit native-host login return must never fall through to another Claw.
      selected = items.find(
        (item) => item.id === intendedAgent && item.namespaceId === intendedNamespace,
      );
      if (!selected) {
        panel(
          view,
          "You don’t have access to this Claw",
          "Your access may have changed. Contact your administrator if you think this is a mistake.",
          "Back to my workspaces",
          choose,
        );
        return;
      }
    } else if (items.length === 1 && url.searchParams.get("choose") !== "1") {
      selected = items[0];
    }
    if (selected?.status === "available") {
      panel(view, `Opening ${selected.name}…`, "Taking you to your workspace.");
      view.append(element("a", { className: "primary", href: selected.url }, "Continue"));
      location.replace(selected.url);
      return;
    }
    if (items.length === 0) {
      panel(
        view,
        "No access assigned",
        "You’re signed in, but no workspaces have been assigned to this account. Contact your administrator to get access.",
        "Check again",
        retry,
      );
      return;
    }
    const visible = selected ? [selected] : items;
    const cards = element("div", { className: "launcher-destinations" });
    for (const item of visible) {
      const [label, description] = availability[item.status];
      cards.append(
        element(
          "article",
          { className: "launcher-destination" },
          element(
            "p",
            {
              className: `launcher-status ${item.status === "available" ? "available" : "unavailable"}`,
            },
            label,
          ),
          element("h2", {}, item.name),
          element(
            "p",
            { className: "muted" },
            item.type === "administration" ? "Manage agents and team access" : description,
          ),
          item.namespaceName ? element("p", { className: "hint" }, item.namespaceName) : null,
          item.url
            ? element(
                "a",
                { className: "launcher-open", href: item.url },
                item.type === "administration" ? "Open administration →" : "Open Claw →",
              )
            : element("p", { className: "hint" }, "Not available to open"),
        ),
      );
    }
    view.replaceChildren(
      element("h1", {}, selected ? "Your workspace is unavailable" : "Where would you like to go?"),
      element(
        "p",
        { className: "muted" },
        selected
          ? "Your access is still assigned. Check the status below or try again."
          : "Choose a workspace to continue.",
      ),
      cards,
      element(
        "div",
        { className: "launcher-footer" },
        element("p", { className: "hint" }, "Only destinations you can access are shown."),
        button("Refresh availability", retry),
      ),
    );
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    panel(
      view,
      "We couldn’t load your workspaces",
      "Something went wrong while checking your destinations. Try again in a moment.",
      "Try again",
      retry,
      error.requestId,
    );
  }
}
