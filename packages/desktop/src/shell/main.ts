import type { DesktopShellState } from "../desktop-api.ts";
import { desktopApi } from "./api.ts";
import "./style.css";

const profile = document.querySelector<HTMLSelectElement>("#profile")!;
const badge = document.querySelector<HTMLElement>("#status-badge")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const manage = document.querySelector<HTMLButtonElement>("#manage")!;
const sync = document.querySelector<HTMLButtonElement>("#sync")!;
const offline = document.querySelector<HTMLElement>("#offline")!;
const offlineTitle = document.querySelector<HTMLElement>("#offline-title")!;
const offlineMessage = document.querySelector<HTMLElement>("#offline-message")!;
const offlineRetry = document.querySelector<HTMLButtonElement>("#offline-retry")!;
const offlineManage = document.querySelector<HTMLButtonElement>("#offline-manage")!;
const offlineExternal = document.querySelector<HTMLButtonElement>("#offline-external")!;

function render(state: DesktopShellState): void {
  const existing = new Map([...profile.options].map((option) => [option.value, option]));
  profile.replaceChildren(
    ...state.profiles.map((item) => {
      const option = existing.get(item.id) ?? document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      option.selected = item.id === state.selectedProfileId;
      return option;
    }),
  );
  sync.hidden = !state.syncProfile;
  sync.classList.toggle("active", state.selectedKind === "sync");
  badge.textContent = state.status;
  badge.dataset.status = state.status;
  retry.hidden = !state.canRetry;
  offline.hidden = state.status !== "offline";
  const selected = state.profiles.find((item) => item.id === state.selectedProfileId);
  const selectedLabel = state.selectedKind === "sync" ? "Cinba Sync" : (selected?.label ?? "Core");
  offlineTitle.textContent = `${selectedLabel} is unavailable`;
  offlineMessage.textContent = state.message ?? "The Core did not respond.";
  offlineExternal.hidden = state.selectedKind !== "sync";
  document.title = `Cinba — ${selectedLabel}`;
}

profile.addEventListener("change", () => void desktopApi.selectProfile(profile.value));
retry.addEventListener("click", () => void desktopApi.retry());
offlineRetry.addEventListener("click", () => void desktopApi.retry());
manage.addEventListener("click", () => void desktopApi.openManager());
offlineManage.addEventListener("click", () => void desktopApi.openManager());
sync.addEventListener("click", () => void desktopApi.openSync());
offlineExternal.addEventListener("click", () => void desktopApi.openSyncExternal());

desktopApi.onStateChanged(render);
void desktopApi.getState().then(render);
