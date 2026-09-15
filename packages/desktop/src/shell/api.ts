import type { CinbaDesktopApi } from "../desktop-api.ts";

export const desktopApi = (window as unknown as { cinbaDesktop: CinbaDesktopApi }).cinbaDesktop;
