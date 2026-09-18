import { fileURLToPath } from "node:url";
import { BrowserWindow, WebContentsView, shell } from "electron";
import { type LocalCoreConfig, ensureLocalCore } from "@cinba/core-manager";
import { type CoreNavigatorState, createCoreNavigator } from "./core-navigator.ts";
import type { ConnectionTestResult, DesktopShellState, ProfileInput } from "./desktop-api.ts";
import { decideCoreNavigation } from "./navigation-policy.ts";
import type { CoreProfileStore } from "./profile-store.ts";
import { createRemoteCoreProfile } from "./profiles.ts";
import { createShellViewModel } from "./shell-view.ts";
import { createNavigationGuard } from "./navigation-guard.ts";
import { remoteContentPreferences } from "./content-security.ts";

const TOOLBAR_HEIGHT = 52;
const PRELOAD_PATH = fileURLToPath(new URL("./desktop-preload.cjs", import.meta.url));
const SHELL_PATH = fileURLToPath(new URL("../dist/shell/index.html", import.meta.url));
const MANAGER_PATH = fileURLToPath(new URL("../dist/shell/manage.html", import.meta.url));
const downloadProtectedSessions = new WeakSet<object>();

type CoreHealth = { status: "ok"; revision: string; safeToRestart: boolean };

function isCoreHealth(value: unknown): value is CoreHealth {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "ok" &&
    typeof candidate.revision === "string" &&
    typeof candidate.safeToRestart === "boolean"
  );
}

async function probeCore(baseUrl: string): Promise<CoreHealth | undefined> {
  try {
    const response = await fetch(new URL("/healthz", baseUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const value: unknown = await response.json();
    return isCoreHealth(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export type DesktopWindowController = {
  open(profileId?: string): Promise<void>;
  retry(): Promise<void>;
  openManager(): Promise<void>;
  getState(): DesktopShellState;
  addProfile(input: ProfileInput): Promise<void>;
  updateProfile(profileId: string, input: ProfileInput): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  recoverProfiles(): Promise<string>;
  testProfile(input: ProfileInput): Promise<ConnectionTestResult>;
  ownsRenderer(id: number): boolean;
};

/** Own the native shell and its isolated Core content view. */
export function createDesktopWindowController(
  profiles: CoreProfileStore,
  localConfig?: LocalCoreConfig,
  options: {
    productName?: "Cinba" | "Cinba Dev";
    expectedRevision?: string;
  } = {},
): DesktopWindowController {
  const productName = options.productName ?? "Cinba Dev";
  let window: BrowserWindow | undefined;
  let manager: BrowserWindow | undefined;
  let coreView: WebContentsView | undefined;
  let selected = profiles.lastSelected();
  let adapterFailure: CoreNavigatorState | undefined;
  const navigation = createNavigationGuard();

  const navigator = createCoreNavigator({
    ensureLocal: async () => {
      await ensureLocalCore(
        localConfig
          ? {
              config: localConfig,
              ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
            }
          : undefined,
      );
    },
    probe: async (baseUrl) => Boolean(await probeCore(baseUrl)),
    load: async (baseUrl) => {
      if (!coreView) {
        throw new Error("Core content view is unavailable");
      }
      await coreView.webContents.loadURL(baseUrl);
    },
  });

  function currentConnection(): CoreNavigatorState {
    return adapterFailure ?? navigator.current() ?? { type: "opening", profile: selected };
  }

  function getState(): DesktopShellState {
    const problem = profiles.problem();
    const core = createShellViewModel(profiles.list(), currentConnection());
    const state = {
      ...core,
      productName,
      canRecoverProfiles: profiles.canRecover(),
      ...(problem ? { problem } : {}),
    };
    return state;
  }

  function broadcast(): void {
    const state = getState();
    for (const target of [window, manager]) {
      if (target && !target.isDestroyed()) {
        target.webContents.send("desktop:state-changed", state);
      }
    }
  }

  function layout(): void {
    if (!window || !coreView) {
      return;
    }
    const [width, height] = window.getContentSize();
    coreView.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    });
  }

  function applyConnection(state: CoreNavigatorState): void {
    if (!window || !coreView) {
      return;
    }
    coreView.setVisible(state.type === "online");
    window.setTitle(`${productName} — ${state.profile.label}`);
    broadcast();
  }

  function protectCoreNavigation(view: WebContentsView): void {
    view.webContents.on("will-navigate", (event) => {
      const decision = decideCoreNavigation(selected.baseUrl, event.url);
      if (decision === "allow") {
        return;
      }
      event.preventDefault();
      if (decision === "external") {
        void shell.openExternal(event.url);
      }
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideCoreNavigation(selected.baseUrl, url);
      if (decision === "external") {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
  }

  function replaceCoreView(): void {
    if (!window) {
      throw new Error("Desktop window is unavailable");
    }
    if (coreView) {
      window.contentView.removeChildView(coreView);
      coreView.webContents.close();
    }
    const view = new WebContentsView({
      webPreferences: remoteContentPreferences(),
    });
    coreView = view;
    coreView.setVisible(false);
    protectCoreNavigation(coreView);
    const contentSession = coreView.webContents.session;
    if (!downloadProtectedSessions.has(contentSession)) {
      downloadProtectedSessions.add(contentSession);
      contentSession.on("will-download", (event) => event.preventDefault());
    }
    view.webContents.on("render-process-gone", (_event, details) => {
      if (view !== coreView) {
        return;
      }
      adapterFailure = {
        type: "offline",
        profile: selected,
        message: `Core content stopped: ${details.reason}`,
      };
      applyConnection(adapterFailure);
    });
    window.contentView.addChildView(coreView);
    layout();
  }

  async function ensureWindow(): Promise<void> {
    if (window && !window.isDestroyed()) {
      return;
    }
    window = new BrowserWindow({
      width: 980,
      height: 760,
      title: productName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: PRELOAD_PATH,
      },
    });
    window.on("resize", layout);
    window.once("closed", () => {
      coreView?.webContents.close();
      coreView = undefined;
      window = undefined;
    });
    await window.loadFile(SHELL_PATH);
    layout();
  }

  async function open(profileId?: string): Promise<void> {
    const request = navigation.begin();
    await ensureWindow();
    if (!navigation.current(request)) {
      return;
    }
    const targetId = profileId ?? profiles.lastSelected().id;
    const target = profiles.list().find((profile) => profile.id === targetId);
    if (!target) {
      throw new Error(`Unknown Core profile: ${targetId}`);
    }
    profiles.select(target.id);
    selected = target;
    adapterFailure = undefined;
    replaceCoreView();
    const opening = navigator.open(target);
    applyConnection(currentConnection());
    await opening;
    if (!navigation.current(request)) {
      return;
    }
    applyConnection(currentConnection());
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    }
  }

  async function retry(): Promise<void> {
    await open(selected.id);
  }

  async function openManager(): Promise<void> {
    await ensureWindow();
    if (manager && !manager.isDestroyed()) {
      manager.focus();
      return;
    }
    manager = new BrowserWindow({
      width: 760,
      height: 720,
      title: `Manage Connections — ${productName}`,
      parent: window,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: PRELOAD_PATH,
      },
    });
    manager.once("closed", () => {
      manager = undefined;
    });
    await manager.loadFile(MANAGER_PATH);
  }

  async function addProfile(input: ProfileInput): Promise<void> {
    profiles.add(input);
    broadcast();
  }

  async function updateProfile(profileId: string, input: ProfileInput): Promise<void> {
    const updated = profiles.update(profileId, input);
    if (selected.id === profileId) {
      selected = updated;
      await open(profileId);
    } else {
      broadcast();
    }
  }

  async function removeProfile(profileId: string): Promise<void> {
    profiles.remove(profileId);
    broadcast();
  }

  async function recoverProfiles(): Promise<string> {
    const backupPath = profiles.recover();
    selected = profiles.lastSelected();
    broadcast();
    return backupPath;
  }

  async function testProfile(input: ProfileInput): Promise<ConnectionTestResult> {
    const candidate = createRemoteCoreProfile(input, () => "test");
    const health = await probeCore(candidate.baseUrl);
    return health
      ? { reachable: true, revision: health.revision, safeToRestart: health.safeToRestart }
      : { reachable: false, message: `${candidate.label} is unavailable` };
  }

  return {
    open,
    retry,
    openManager,
    getState,
    addProfile,
    updateProfile,
    removeProfile,
    recoverProfiles,
    testProfile,
    ownsRenderer: (id) =>
      [window, manager].some(
        (target) => target && !target.isDestroyed() && target.webContents.id === id,
      ),
  };
}
