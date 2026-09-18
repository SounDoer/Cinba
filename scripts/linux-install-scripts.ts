export function renderBundledLinuxInstaller(): string {
  return `#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "Cinba must be installed as a non-root user." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/launcher/cinba" install
`;
}

export function renderLinuxBootstrap(options: {
  version: string;
  artifactName: string;
  artifactSha256: string;
}): string {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("Linux bootstrap requires a stable SemVer");
  }
  if (!/^Cinba-\d+\.\d+\.\d+-linux-x64-gnu\.tar\.gz$/.test(options.artifactName)) {
    throw new Error("Linux bootstrap artifact name is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(options.artifactSha256)) {
    throw new Error("Linux bootstrap artifact SHA-256 is invalid");
  }
  const base = `https://github.com/SounDoer/Cinba/releases/download/v${options.version}`;
  return `#!/bin/sh
set -eu

VERSION='${options.version}'
ARTIFACT='${options.artifactName}'
EXPECTED_SHA256='${options.artifactSha256}'
BASE_URL='${base}'

if [ "$(id -u)" -eq 0 ]; then
  echo "Cinba must be installed as a non-root user." >&2
  exit 1
fi
if [ "$(uname -s)" != 'Linux' ] || [ "$(uname -m)" != 'x86_64' ]; then
  echo "Cinba Headless supports Linux x86_64 only." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download Cinba." >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify Cinba." >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required to unpack Cinba." >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf -- "$TEMP_DIR"' EXIT HUP INT TERM
ARCHIVE="$TEMP_DIR/$ARTIFACT"
BUNDLE="$TEMP_DIR/bundle"
mkdir -p -- "$BUNDLE"
curl -fL --proto '=https' --tlsv1.2 "$BASE_URL/$ARTIFACT" -o "$ARCHIVE"
printf '%s  %s\n' "$EXPECTED_SHA256" "$ARCHIVE" | sha256sum -c -
tar -xzf "$ARCHIVE" -C "$BUNDLE"
"$BUNDLE/install.sh"
`;
}
