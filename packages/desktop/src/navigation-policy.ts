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

export function decideSyncNavigation(
  syncBaseUrl: string,
  targetUrl: string,
): CoreNavigationDecision {
  return decideOriginNavigation(syncBaseUrl, targetUrl);
}
