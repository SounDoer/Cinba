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

  for (const entry of snapshot.entries) {
    if (entry.kind === "message") renderMessage(entry);
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
