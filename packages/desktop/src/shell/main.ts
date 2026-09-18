import {
  type DesktopShellState,
  activateDesktopUpdate,
  createDesktopUpdatePresentation,
} from "../desktop-api.ts";
import { desktopApi } from "./api.ts";
import "./style.css";

const profile = document.querySelector<HTMLSelectElement>("#profile")!;
const badge = document.querySelector<HTMLElement>("#status-badge")!;
const updatePill = document.querySelector<HTMLButtonElement>("#update-pill")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const manage = document.querySelector<HTMLButtonElement>("#manage")!;
const offline = document.querySelector<HTMLElement>("#offline")!;
const offlineTitle = document.querySelector<HTMLElement>("#offline-title")!;
const offlineMessage = document.querySelector<HTMLElement>("#offline-message")!;
const offlineRetry = document.querySelector<HTMLButtonElement>("#offline-retry")!;
const offlineManage = document.querySelector<HTMLButtonElement>("#offline-manage")!;
const brand = document.querySelector<HTMLElement>("#product-name")!;
let updatePresentation = createDesktopUpdatePresentation("Cinba Dev", undefined);

function render(state: DesktopShellState): void {
  const existing = new Map([...profile.options].map((option) => [option.value, option]));
  brand.textContent = state.productName;
  profile.replaceChildren(
    ...state.profiles.map((item) => {
      const option = existing.get(item.id) ?? document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      option.selected = item.id === state.selectedProfileId;
      return option;
    }),
  );
  badge.textContent = state.status;
  badge.dataset.status = state.status;
  updatePresentation = createDesktopUpdatePresentation(state.productName, state.update);
  updatePill.textContent = updatePresentation.label;
  updatePill.hidden = updatePresentation.hidden;
  updatePill.disabled = !updatePresentation.actionable;
  updatePill.ariaLabel = updatePresentation.ariaLabel;
  retry.hidden = !state.canRetry;
  offline.hidden = state.status !== "offline";
  const selected = state.profiles.find((item) => item.id === state.selectedProfileId);
  const selectedLabel = selected?.label ?? "Core";
  offlineTitle.textContent = `${selectedLabel} is unavailable`;
  offlineMessage.textContent = state.message ?? "The Core did not respond.";
  document.title = `${state.productName} — ${selectedLabel}`;
}

profile.addEventListener("change", () => void desktopApi.selectProfile(profile.value));
retry.addEventListener("click", () => void desktopApi.retry());
offlineRetry.addEventListener("click", () => void desktopApi.retry());
manage.addEventListener("click", () => void desktopApi.openManager());
updatePill.addEventListener(
  "click",
  () => void activateDesktopUpdate(updatePresentation, desktopApi.installReadyUpdate),
);
offlineManage.addEventListener("click", () => void desktopApi.openManager());

desktopApi.onStateChanged(render);
void desktopApi.getState().then(render);
