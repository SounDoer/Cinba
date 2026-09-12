import { posix } from "node:path";

export type DeploymentConfig = {
  repoPath: string;
  releasesRoot: string;
  currentLink: string;
  statusPath: string;
  lockPath: string;
  healthUrl: string;
  webSocketUrl: string;
};

/** Derive the fixed VPS layout from the service user's home directory. */
export function deploymentConfig(homeDirectory: string): DeploymentConfig {
  if (!posix.isAbsolute(homeDirectory)) {
    throw new Error("Deployment home must be an absolute POSIX path");
  }
  const home = posix.resolve(homeDirectory);
  if (home === "/") {
    throw new Error("Filesystem root cannot be used as the deployment home");
  }
  return {
    repoPath: posix.join(home, "Cinba"),
    releasesRoot: posix.join(home, "releases"),
    currentLink: posix.join(home, "current"),
    statusPath: posix.join(home, ".cinba", "deployment.json"),
    lockPath: posix.join(home, ".cinba", "deployment.lock"),
    healthUrl: "http://127.0.0.1:4517/healthz",
    webSocketUrl: "ws://127.0.0.1:4517/ws",
  };
}
