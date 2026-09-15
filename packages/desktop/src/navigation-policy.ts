export type CoreNavigationDecision = "allow" | "external" | "deny";

export function decideCoreNavigation(
  profileBaseUrl: string,
  targetUrl: string,
): CoreNavigationDecision {
  const target = new URL(targetUrl);
  if (new URL(profileBaseUrl).origin === target.origin) {
    return "allow";
  }
  return target.protocol === "https:" || target.protocol === "http:" ? "external" : "deny";
}
