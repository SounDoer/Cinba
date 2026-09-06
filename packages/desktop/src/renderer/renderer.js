// 渲染层。只做两件事：把动作画出来，把用户的操作发回主进程。
//
// 这里没有任何真相——所有状态都在主进程。刷新页面时向主进程要一次快照，
// 整段对话就回来了。

const transcript = document.getElementById("transcript");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const abortButton = document.getElementById("abort");
const projectButton = document.getElementById("project");
const usageLabel = document.getElementById("usage");

/** messageId → 那条消息的正文节点。 */
const textNodes = new Map();

/** toolCallId → { node, entry }，用来原地更新卡片。 */
const toolNodes = new Map();

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
  abortButton.hidden = !busy;
  if (!busy) input.focus();
}

function renderMessage(entry) {
  const box = document.createElement("div");
  box.className = `entry ${entry.role}`;

  const role = document.createElement("div");
  role.className = "role";
  role.textContent = entry.role === "user" ? "你" : "助手";
  box.append(role);

  const text = document.createElement("div");
  // textContent 而非 innerHTML：这是模型生成的内容，绝不能让它往界面里注入标记。
  text.textContent = entry.text;
  box.append(text);

  transcript.append(box);
  textNodes.set(entry.messageId, text);
  return box;
}

const STATUS_LABEL = {
  pending: "待批准",
  running: "执行中",
  done: "完成",
  error: "被拒绝或出错",
};

function renderTool(entry) {
  const box = document.createElement("div");
  box.className = `tool ${entry.status}`;

  const head = document.createElement("div");
  head.className = "tool-head";

  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = entry.toolName;

  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = STATUS_LABEL[entry.status] ?? entry.status;

  head.append(name, status);
  box.append(head);

  if (entry.args !== undefined) {
    const args = document.createElement("pre");
    args.className = "tool-args";
    args.textContent = JSON.stringify(entry.args, null, 2);
    box.append(args);
  }

  if (entry.result) {
    const result = document.createElement("pre");
    result.className = "tool-result";
    result.textContent = entry.result;
    box.append(result);
  }

  if (entry.confirmRequestId) {
    const row = document.createElement("div");
    row.className = "tool-confirm";
    const requestId = entry.confirmRequestId;

    const allow = document.createElement("button");
    allow.className = "allow";
    allow.textContent = "允许";
    allow.addEventListener("click", () => void window.cinba.respondConfirm(requestId, true));

    const deny = document.createElement("button");
    deny.className = "deny";
    deny.textContent = "拒绝";
    deny.addEventListener("click", () => void window.cinba.respondConfirm(requestId, false));

    row.append(allow, deny);
    box.append(row);
  }

  transcript.append(box);
  toolNodes.set(entry.toolCallId, { node: box, entry });
  return box;
}

/** 卡片的变化很杂（状态、结果、按钮增减），整张重画最简单也最不容易错。 */
function updateTool(entry) {
  const existing = toolNodes.get(entry.toolCallId);
  if (!existing) {
    renderTool(entry);
    return;
  }
  const merged = { ...existing.entry, ...entry };
  const fresh = renderTool(merged);
  // renderTool 把新节点接在了末尾，这里用它替换掉原位置的旧节点，顺序才不会乱。
  existing.node.replaceWith(fresh);
}

function scrollToBottom() {
  transcript.scrollTop = transcript.scrollHeight;
}

function applyAction(action) {
  switch (action.type) {
    case "message_added":
      renderMessage({ messageId: action.messageId, role: action.role, text: "" });
      break;

    case "text_appended": {
      const node = textNodes.get(action.messageId);
      if (node) node.textContent += action.text;
      break;
    }

    case "tool_changed":
      updateTool({
        kind: "tool",
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        args: action.args,
        status: action.status,
        result: action.result,
        confirmRequestId:
          action.status === "pending"
            ? toolNodes.get(action.toolCallId)?.entry.confirmRequestId
            : undefined,
      });
      break;

    case "confirm_requested": {
      // 确认请求不带 toolCallId，挂到最近一张待批准的卡片上。
      const pending = [...toolNodes.values()]
        .reverse()
        .find((item) => item.entry.status === "pending");
      if (pending) {
        updateTool({ ...pending.entry, confirmRequestId: action.requestId });
      }
      break;
    }

    case "usage_changed":
      usageLabel.textContent = `${action.totalTokens} tokens · $${action.totalCost.toFixed(4)}`;
      break;

    case "busy_changed":
      setBusy(action.busy);
      break;
  }
  scrollToBottom();
}

/** 由快照整份重画。启动时与切换项目后各调一次。 */
function renderSnapshot(snapshot) {
  transcript.replaceChildren();
  textNodes.clear();
  toolNodes.clear();

  for (const entry of snapshot.entries) {
    if (entry.kind === "message") renderMessage(entry);
    else renderTool(entry);
  }

  usageLabel.textContent = `${snapshot.totalTokens} tokens · $${snapshot.totalCost.toFixed(4)}`;
  setBusy(snapshot.busy);
  scrollToBottom();
}

function send() {
  const text = input.value.trim();
  if (text === "") return;
  input.value = "";
  void window.cinba.prompt(text);
}

sendButton.addEventListener("click", send);
abortButton.addEventListener("click", () => void window.cinba.abort());

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

projectButton.addEventListener("click", async () => {
  const cwd = await window.cinba.chooseProject();
  projectButton.textContent = `项目：${cwd.split(/[\\/]/).pop()}`;
});

window.cinba.onActions((actions) => {
  for (const action of actions) applyAction(action);
});

window.cinba.onReset(async (cwd) => {
  projectButton.textContent = `项目：${cwd.split(/[\\/]/).pop()}`;
  renderSnapshot(await window.cinba.getSnapshot());
});

void (async () => {
  const cwd = await window.cinba.getProject();
  projectButton.textContent = `项目：${cwd.split(/[\\/]/).pop()}`;
  renderSnapshot(await window.cinba.getSnapshot());
})();
