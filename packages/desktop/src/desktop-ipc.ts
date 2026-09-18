type DesktopIpcFrame = { url: string };
type DesktopIpcEvent = {
  sender: { id: number; mainFrame: DesktopIpcFrame };
  senderFrame: DesktopIpcFrame | null;
};

export function authorizeDesktopIpcEvent(
  event: DesktopIpcEvent,
  ownsRendererFrame: (id: number, url: string) => boolean,
): void {
  if (
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !ownsRendererFrame(event.sender.id, event.senderFrame.url)
  ) {
    throw new Error("Untrusted Desktop IPC sender");
  }
}
