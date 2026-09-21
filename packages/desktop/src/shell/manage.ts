import type { DesktopShellState, ProfileInput } from "../desktop-api.ts";
import type { CoreProfile } from "../profiles.ts";
import { normalizeRemoteCoreBaseUrl } from "../remote-core-url.ts";
import { desktopApi } from "./api.ts";
import "./style.css";

const list = document.querySelector<HTMLElement>("#profiles")!;
const problem = document.querySelector<HTMLElement>("#problem")!;
const recoverButton = document.querySelector<HTMLButtonElement>("#recover")!;
const form = document.querySelector<HTMLFormElement>("#profile-form")!;
const editorTitle = document.querySelector<HTMLElement>("#editor-title")!;
const idInput = document.querySelector<HTMLInputElement>("#profile-id")!;
const labelInput = document.querySelector<HTMLInputElement>("#label")!;
const urlInput = document.querySelector<HTMLInputElement>("#base-url")!;
const formMessage = document.querySelector<HTMLElement>("#form-message")!;
const testButton = document.querySelector<HTMLButtonElement>("#test")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
let state: DesktopShellState;
const productName = document.querySelector<HTMLElement>("#product-name")!;

function input(): ProfileInput {
  const baseUrl = normalizeRemoteCoreBaseUrl(urlInput.value);
  urlInput.value = baseUrl;
  return { label: labelInput.value, baseUrl };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error|TypeError): /, "");
}

function resetEditor(): void {
  idInput.value = "";
  labelInput.value = "";
  urlInput.value = "";
  editorTitle.textContent = "Add remote Core";
  cancelButton.hidden = true;
  formMessage.textContent = "";
}

function edit(profile: CoreProfile): void {
  if (profile.kind !== "remote") {
    return;
  }
  idInput.value = profile.id;
  labelInput.value = profile.label;
  urlInput.value = profile.baseUrl;
  editorTitle.textContent = `Edit ${profile.label}`;
  cancelButton.hidden = false;
  labelInput.focus();
}

function profileCard(profile: CoreProfile): HTMLElement {
  const card = document.createElement("article");
  card.className = "profile-card";
  const text = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = profile.label;
  const url = document.createElement("span");
  url.textContent = profile.baseUrl;
  text.append(name, url);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (profile.kind === "remote") {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "quiet";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => edit(profile));
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger quiet";
    removeButton.textContent = "Remove";
    removeButton.disabled = profile.id === state.selectedProfileId;
    removeButton.title = removeButton.disabled
      ? "Select another Core before removing this one"
      : "";
    removeButton.addEventListener("click", async () => {
      if (confirm(`Remove ${profile.label}?`)) {
        await desktopApi.removeProfile(profile.id);
      }
    });
    actions.append(editButton, removeButton);
  } else {
    const fixed = document.createElement("span");
    fixed.className = "fixed-label";
    fixed.textContent = "Built in";
    actions.append(fixed);
  }
  card.append(text, actions);
  return card;
}

function render(next: DesktopShellState): void {
  state = next;
  productName.textContent = `${state.productName} Desktop`;
  document.title = `Manage Connections — ${state.productName}`;
  list.replaceChildren(...state.profiles.map(profileCard));
  problem.hidden = !state.problem;
  problem.textContent = state.problem ?? "";
  recoverButton.hidden = !state.canRecoverProfiles;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "Saving…";
  try {
    if (idInput.value) {
      await desktopApi.updateProfile(idInput.value, input());
    } else {
      await desktopApi.addProfile(input());
    }
    resetEditor();
  } catch (error) {
    formMessage.textContent = errorMessage(error);
  }
});

testButton.addEventListener("click", async () => {
  formMessage.textContent = "Testing…";
  try {
    const result = await desktopApi.testProfile(input());
    formMessage.textContent = result.reachable
      ? `Connected · revision ${result.revision}`
      : result.message;
  } catch (error) {
    formMessage.textContent = errorMessage(error);
  }
});

cancelButton.addEventListener("click", resetEditor);
recoverButton.addEventListener("click", async () => {
  if (!confirm("Back up the unreadable file and reset Desktop Core profiles?")) {
    return;
  }
  try {
    const backupPath = await desktopApi.recoverProfiles();
    formMessage.textContent = `The unreadable file was preserved at ${backupPath}`;
  } catch (error) {
    formMessage.textContent = errorMessage(error);
  }
});
desktopApi.onStateChanged(render);
void desktopApi.getState().then(render);
