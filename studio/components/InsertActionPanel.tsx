"use client";

import { useState } from "react";
import { CHEAT_SHEET, INSERT_ACTIONS, scriptSafeName } from "@/lib/scriptTags";

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
  const exampleName = scriptSafeName(name);
  const [cheatOpen, setCheatOpen] = useState(false);
  return (
    <div className="border-t border-studio-border bg-studio-panel px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Insert Action</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="cheat-sheet-toggle"
            aria-expanded={cheatOpen}
            onClick={() => setCheatOpen((open) => !open)}
            className={`rounded-md border px-2.5 py-1 text-xs hover:text-white ${
              cheatOpen ? "border-studio-accent text-white" : "border-studio-border text-neutral-200"
            } bg-studio-raised`}
          >
            Cheat sheet {cheatOpen ? "▾" : "▸"}
          </button>
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
      {cheatOpen ? (
        <div
          className="mb-3 max-h-72 overflow-auto rounded-md border border-studio-border bg-black/30 p-3"
          data-testid="cheat-sheet"
        >
          <p className="mb-3 text-[11px] text-studio-muted">
            Click an example to drop it into the script at the cursor. Names like museum, my_take, mic_stand and
            turn are examples: swap in your own. Character names with a space are written as their id
            (colnel_klink) in every tag except [Cast:].
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {CHEAT_SHEET.map((group) => (
              <section key={group.id} data-testid={`cheat-group-${group.id}`}>
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-studio-accent">
                  {group.title}
                </h4>
                <ul className="space-y-1.5">
                  {group.entries.map((entry) => {
                    const text = entry.example(entry.id === "cast" ? name : exampleName);
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          data-testid="cheat-example"
                          data-id={entry.id}
                          onClick={() => onInsert(text)}
                          className="block w-full break-words rounded border border-transparent px-1.5 py-0.5 text-left font-mono text-[11px] text-neutral-100 hover:border-studio-accent hover:bg-studio-raised"
                        >
                          {text}
                        </button>
                        <p className="px-1.5 text-[10px] leading-snug text-studio-muted">{entry.note}</p>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
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
