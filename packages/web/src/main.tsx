// 冒烟实验：验证 Vite 能把 @cinba/core-client 编译进浏览器包。
// 这一版不连服务器、不画界面。

import { createRoot } from "react-dom/client";
import { parseClientMessage } from "@cinba/core-client";

const parsed = parseClientMessage({ type: "prompt", text: "你好" });

createRoot(document.getElementById("root")!).render(
  <div style={{ fontFamily: "system-ui", padding: "2rem" }}>
    <h1>Vite 冒烟实验</h1>
    <p>
      从 core-client 导入的 parseClientMessage 返回：
      <code>{JSON.stringify(parsed)}</code>
    </p>
    <p>看到上面那行 JSON，就说明 core-client 能编译进浏览器。</p>
  </div>,
);
