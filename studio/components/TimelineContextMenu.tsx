"use client";

export type TimelineContextAction =
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "delete"
  | "ripple"
  | "sync"
  | "redo-sync"
  | "clear-lipsync"
  | "split-long-audio";

export default function TimelineContextMenu({
  x,
  y,
  canEdit,
  canPaste,
  hasSelection,
  showSync,
  syncLabel,
  mouthOnly = false,
  showSplitLong = false,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  canEdit: boolean;
  canPaste: boolean;
  hasSelection: boolean;
  showSync: boolean;
  syncLabel: string;
  mouthOnly?: boolean;
  showSplitLong?: boolean;
  onAction: (action: TimelineContextAction) => void;
  onClose: () => void;
}) {
  function run(action: TimelineContextAction) {
    onAction(action);
    onClose();
  }

  return (
    <div
      className="studio-ctx-menu"
      data-testid="timeline-context-menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MenuItem label="Copy" kbd="Ctrl+C" disabled={!hasSelection} onClick={() => run("copy")} />
      <MenuItem label="Cut" kbd="Ctrl+X" disabled={!canEdit || !hasSelection} onClick={() => run("cut")} />
      <MenuItem label="Paste" kbd="Ctrl+V" disabled={!canEdit || !canPaste} onClick={() => run("paste")} />
      <MenuItem label="Duplicate" kbd="Ctrl+D" disabled={!canEdit || !hasSelection} onClick={() => run("duplicate")} />
      <div className="studio-ctx-sep" />
      {mouthOnly ? (
        <>
          <MenuItem label="Clear lip sync" kbd="Del" disabled={!canEdit || !hasSelection} onClick={() => run("clear-lipsync")} />
          <MenuItem label="Redo sync" disabled={!canEdit} onClick={() => run("redo-sync")} />
        </>
      ) : (
        <>
          <MenuItem label="Delete" kbd="Del" disabled={!canEdit || !hasSelection} onClick={() => run("delete")} />
          <MenuItem
            label="Ripple delete"
            kbd="Shift+Del"
            disabled={!canEdit || !hasSelection}
            onClick={() => run("ripple")}
          />
          {showSync ? (
            <>
              <div className="studio-ctx-sep" />
              <MenuItem label={syncLabel} disabled={!canEdit} onClick={() => run(syncLabel.startsWith("Redo") ? "redo-sync" : "sync")} />
            </>
          ) : null}
          {showSplitLong ? (
            <MenuItem
              label="Split long audio"
              disabled={!canEdit}
              onClick={() => run("split-long-audio")}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function MenuItem({
  label,
  kbd,
  disabled,
  onClick,
}: {
  label: string;
  kbd?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="studio-ctx-item"
      data-testid={`timeline-ctx-${label.toLowerCase().replace(/\s+/g, "-")}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {kbd ? <span className="studio-ctx-kbd">{kbd}</span> : null}
    </button>
  );
}
