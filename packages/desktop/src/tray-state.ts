import type { LocalCoreStatus } from "@cinba/core-manager";

export type TrayOperation = "starting" | "stopping";
export type TrayIconTone = "stopped" | "running" | "busy" | "error";

export type TrayViewModel = {
  tooltip: string;
  iconTone: TrayIconTone;
  statusLabel: string;
  detailLabels: string[];
  canStart: boolean;
  canStop: boolean;
};

export function createTrayViewModel(
  status: LocalCoreStatus,
  operation?: TrayOperation,
  error?: string,
): TrayViewModel {
  const detailLabels: string[] = [];
  if (status.pid !== undefined) {
    detailLabels.push(`PID: ${status.pid}`);
  }
  if (status.clientCount !== undefined) {
    detailLabels.push(`Clients: ${status.clientCount}`);
  }
  if (status.running && status.safeToStop === false) {
    detailLabels.push("Core is busy; stopping will drain current work");
  }
  if (error) {
    detailLabels.push(`Error: ${error}`);
  }

  if (operation) {
    const action = operation === "starting" ? "starting" : "stopping";
    return {
      tooltip: `Cinba Core: ${action}`,
      iconTone: error ? "error" : "busy",
      statusLabel: `Core: ${action}`,
      detailLabels,
      canStart: false,
      canStop: false,
    };
  }

  if (!status.running) {
    return {
      tooltip: error ? "Cinba Core: status error" : "Cinba Core: stopped",
      iconTone: error ? "error" : "stopped",
      statusLabel: "Core: stopped",
      detailLabels,
      canStart: true,
      canStop: false,
    };
  }

  const external = !status.managed;
  let state = "running";
  let iconTone: TrayIconTone = "running";
  if (status.state === "draining") {
    state = "draining";
    iconTone = "busy";
  } else if (external) {
    state = "external";
  }
  if (error) {
    iconTone = "error";
  }
  return {
    tooltip: error ? "Cinba Core: status error" : `Cinba Core: ${state}`,
    iconTone,
    statusLabel: `Core: ${state}`,
    detailLabels,
    canStart: false,
    canStop: status.managed && status.state !== "draining",
  };
}
