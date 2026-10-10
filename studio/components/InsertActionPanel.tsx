"use client";

import { INSERT_ACTIONS } from "@/lib/scriptTags";

export default function InsertActionPanel({
  castNames,
  selectedName,
  onSelectName,
  onInsert,
  onImportAudio,
}: {
  castNames: string[];
  selectedName: string;
  onSelectName: (name: string) => void;
  onInsert: (text: string) => void;
  onImportAudio?: () => void;
}) {
  const name = selectedName || castNames[0] || "Name";
  return (
    <div className="border-t border-studio-border bg-studio-panel px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Insert Action</h3>
        <div className="flex items-center gap-2">
          {onImportAudio ? (
            <button
              type="button"
              data-testid="import-audio-open"
              onClick={onImportAudio}
              className="rounded-md border border-studio-accent/50 bg-studio-raised px-2.5 py-1 text-xs text-neutral-200 hover:border-studio-accent hover:text-white"
            >
              Import audio (mp3/wav)
            </button>
          ) : null}
          <label className="flex items-center gap-2 text-[11px] text-studio-muted">
            Cast
            <select
              className="rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
              value={name}
              onChange={(event) => onSelectName(event.target.value)}
              disabled={castNames.length === 0}
            >
              {castNames.length === 0 ? <option value="Name">No characters</option> : null}
              {castNames.map((castName) => (
                <option key={castName} value={castName}>
                  {castName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {INSERT_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => onInsert(action.template(name))}
            className="rounded-md border border-studio-border bg-studio-raised px-2.5 py-1 text-xs text-neutral-200 hover:border-studio-accent hover:text-white"
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
