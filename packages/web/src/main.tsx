// Start the React application in the current browser or Electron page.

import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./style.css";

const webSocketProtocol = location.protocol === "https:" ? "wss" : "ws";
const serverUrl = `${webSocketProtocol}://${location.host}/ws`;

// Hot reload re-executes this module, and createRoot must not run twice on the
// same container. Reuse the existing root, or development hits state confusion
// that looks exactly like "clicking does nothing".
const container = document.getElementById("root")!;
const globals = globalThis as { __cinbaRoot?: ReturnType<typeof createRoot> };
globals.__cinbaRoot ??= createRoot(container);
globals.__cinbaRoot.render(<App serverUrl={serverUrl} />);
