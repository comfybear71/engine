"use client";

export type TimelineContextAction =
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "delete"
  | "ripple"
  | "sync"
  | "redo-sync";

export default function TimelineContextMenu({
  x,
  y,
  canEdit,
  canPaste,
  hasSelection,
  showSync,
  syncLabel,
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
