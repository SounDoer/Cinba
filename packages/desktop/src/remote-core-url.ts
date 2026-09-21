export function normalizeRemoteCoreBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error("Remote Core address is required");
  }

  let candidate = value;
  if (value.startsWith("//")) {
    candidate = `https:${value}`;
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    candidate = `https://${value}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid remote Core address");
  }

  if (url.protocol !== "https:") {
    throw new Error("Remote Core address must use HTTPS");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Remote Core address must point at an origin root");
  }
  return `${url.origin}/`;
}
