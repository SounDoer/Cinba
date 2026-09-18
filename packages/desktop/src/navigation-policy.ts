export type CoreNavigationDecision = "allow" | "external" | "deny";

function decideOriginNavigation(allowedBaseUrl: string, targetUrl: string): CoreNavigationDecision {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return "deny";
  }
  if (new URL(allowedBaseUrl).origin === target.origin) {
    return target.protocol === "https:" || target.protocol === "http:" ? "allow" : "deny";
  }
  return target.protocol === "https:" || target.protocol === "http:" ? "external" : "deny";
}

export function decideCoreNavigation(
  profileBaseUrl: string,
  targetUrl: string,
): CoreNavigationDecision {
  return decideOriginNavigation(profileBaseUrl, targetUrl);
}

export function decideDesktopNavigation(
  expectedFileUrl: string,
  targetUrl: string,
): CoreNavigationDecision {
  let expected: URL;
  let target: URL;
  try {
    expected = new URL(expectedFileUrl);
    target = new URL(targetUrl);
  } catch {
    return "deny";
  }
  if (expected.protocol === "file:" && target.href === expected.href) {
    return "allow";
  }
  return target.protocol === "https:" || target.protocol === "http:" ? "external" : "deny";
}

type DesktopNavigationEvent = { url: string; preventDefault(): void };
type DesktopNavigationTarget = {
  on(event: "will-navigate", listener: (event: DesktopNavigationEvent) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
};

export function protectDesktopNavigation(
  target: DesktopNavigationTarget,
  expectedFileUrl: string,
  openExternal: (url: string) => void,
): void {
  target.on("will-navigate", (event) => {
    const decision = decideDesktopNavigation(expectedFileUrl, event.url);
    if (decision === "allow") {
      return;
    }
    event.preventDefault();
    if (decision === "external") {
      openExternal(event.url);
    }
  });
  target.setWindowOpenHandler(({ url }) => {
    if (decideDesktopNavigation(expectedFileUrl, url) === "external") {
      openExternal(url);
    }
    return { action: "deny" };
  });
}
