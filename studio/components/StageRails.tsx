"use client";

export type LeftPoolId = "assets" | "media" | "effects";
export type RightDrawerId = "marks" | "layers" | "script" | "camera";

function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="9" cy="8" r="3" />
      <path d="M4 19c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M16.2 19c.3-1.8 1.8-3.2 3.8-3.5" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M21 16l-5.5-5.5L7 19" />
    </svg>
  );
}

function IconCube() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  );
}

function IconCrosshair() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 4l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 16l8 4 8-4" />
    </svg>
  );
}

function IconScript() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 4h8l4 4v12H7V4z" />
      <path d="M15 4v4h4M9 12h6M9 16h6" />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 8h3l2-2h6l2 2h3v11H4V8z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

const LEFT_ITEMS: { id: LeftPoolId; label: string; icon: typeof IconUsers }[] = [
  { id: "assets", label: "Assets", icon: IconUsers },
  { id: "media", label: "Media", icon: IconImage },
  { id: "effects", label: "Effects", icon: IconCube },
];

const RIGHT_ITEMS: { id: RightDrawerId; label: string; icon: typeof IconCrosshair }[] = [
  { id: "marks", label: "Marks", icon: IconCrosshair },
  { id: "layers", label: "Layers", icon: IconLayers },
  { id: "script", label: "Script", icon: IconScript },
  { id: "camera", label: "Camera", icon: IconCamera },
];

function RailButton({
  label,
  active,
  testId,
  onClick,
  icon: Icon,
}: {
  label: string;
  active: boolean;
  testId: string;
  onClick: () => void;
  icon: typeof IconUsers;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-md ${
        active ? "bg-studio-accent text-black" : "text-studio-muted hover:bg-studio-raised hover:text-white"
      }`}
    >
      <Icon />
    </button>
  );
}

export function LeftIconRail({
  active,
  onToggle,
}: {
  active: LeftPoolId | null;
  onToggle: (id: LeftPoolId) => void;
}) {
  return (
    <nav
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-studio-border bg-studio-panel py-2"
      data-testid="left-icon-rail"
      aria-label="Media pool"
    >
      {LEFT_ITEMS.map((item) => (
        <RailButton
          key={item.id}
          label={item.label}
          icon={item.icon}
          active={active === item.id}
          testId={`left-rail-${item.id}`}
          onClick={() => onToggle(item.id)}
        />
      ))}
    </nav>
  );
}

export function RightIconRail({
  active,
  onToggle,
}: {
  active: RightDrawerId | null;
  onToggle: (id: RightDrawerId) => void;
}) {
  return (
    <nav
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-studio-border bg-studio-panel py-2"
      data-testid="right-icon-rail"
      aria-label="Inspectors"
    >
      {RIGHT_ITEMS.map((item) => (
        <RailButton
          key={item.id}
          label={item.label}
          icon={item.icon}
          active={active === item.id}
          testId={`right-rail-${item.id}`}
          onClick={() => onToggle(item.id)}
        />
      ))}
    </nav>
  );
}

export function DrawerHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-studio-border px-3 py-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">{title}</h3>
      <button type="button" className="text-xs text-studio-muted hover:text-white" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
