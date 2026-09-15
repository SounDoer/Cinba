import type { ThinkingLevel, ThinkingState } from "@cinba/contract";
import { PickerShell } from "./picker-shell.tsx";

const LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export function ThinkingPicker({
  thinking,
  onSelect,
  onClose,
}: {
  thinking: ThinkingState;
  onSelect: (level: ThinkingLevel) => boolean;
  onClose: () => void;
}) {
  return (
    <PickerShell label="thinking level picker" onClose={onClose}>
      <div className="picker-path">
        This controls reasoning effort for this conversation. The available levels come from the
        current model.
      </div>

      <div className="picker-list">
        {thinking.available.map((level) => {
          const active = level === thinking.level;
          return (
            <button
              className="picker-item"
              key={level}
              onClick={() => {
                if (active || onSelect(level)) {
                  onClose();
                }
              }}
            >
              {active ? "● " : "  "}
              {LABELS[level]}
            </button>
          );
        })}
      </div>

      <div className="picker-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </PickerShell>
  );
}
