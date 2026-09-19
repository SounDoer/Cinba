export type LocalCoreConfig = {
  baseUrl: string;
  repositoryRoot: string;
  serverEntry: string;
  stateDirectory: string;
  piAgentDirectory: string;
  startLockPath: string;
  runtimePath: string;
  controlPath: string;
  logPath: string;
  environment?: NodeJS.ProcessEnv;
  defaultCoreName?: string;
};
