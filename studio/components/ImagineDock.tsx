"use client";

import { useEffect, useMemo, useState } from "react";
import AssetImaginePanel from "@/components/AssetImaginePanel";
import PanelSplitter from "@/components/PanelSplitter";
import {
  DEFAULT_IMAGINE_HEIGHT,
  clampImagineHeight,
  loadImagineHeight,
  saveImagineHeight,
} from "@/lib/stageLayout";
import { loadCharacters, type Character } from "@/lib/worker";

export default function ImagineDock({
  project,
  workerUp,
  open,
  characterId,
  onOpenChange,
  onCharacterId,
  onChanged,
}: {
  project: string;
  workerUp: boolean;
  open: boolean;
  characterId: string | null;
  onOpenChange: (open: boolean) => void;
  onCharacterId: (id: string | null) => void;
  onChanged: () => void;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [height, setHeight] = useState(DEFAULT_IMAGINE_HEIGHT);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setHeight(loadImagineHeight());
  }, []);

  useEffect(() => {
    saveImagineHeight(height);
  }, [height]);

  useEffect(() => {
    if (!workerUp) return;
    let cancelled = false;
    loadCharacters(project)
      .then((chars) => {
        if (cancelled) return;
        setCharacters(chars);
      })
      .catch(() => {
        if (!cancelled) setCharacters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project, workerUp, reloadKey]);

  useEffect(() => {
    if (characters.length === 0) return;
    if (characterId && characters.some((c) => c.id === characterId)) return;
    onCharacterId(characters[0].id);
  }, [characters, characterId, onCharacterId]);

  const selected = useMemo(
    () => characters.find((c) => c.id === characterId) || characters[0] || null,
    [characters, characterId]
  );

  return (
    <div className="flex shrink-0 flex-col bg-studio-panel" data-testid="imagine-dock">
      {open ? (
        <>
          <PanelSplitter
            axis="y"
            label="Resize Grok Imagine"
            testId="splitter-imagine"
            onDrag={(delta) => setHeight((current) => clampImagineHeight(current - delta))}
            onReset={() => setHeight(DEFAULT_IMAGINE_HEIGHT)}
          />
          <div className="flex min-h-0 flex-col overflow-hidden border-t border-studio-border" style={{ height }}>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-studio-border px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">Grok Imagine</h3>
                <label className="flex items-center gap-2 text-[11px] text-studio-muted">
                  Character
                  <select
                    className="rounded-md border border-studio-border bg-studio-raised px-2 py-1 text-xs text-neutral-200"
                    value={selected?.id || ""}
                    onChange={(event) => onCharacterId(event.target.value || null)}
                    disabled={characters.length === 0}
                    data-testid="imagine-character"
                  >
                    {characters.length === 0 ? <option value="">No characters</option> : null}
                    {characters.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.display_name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="text-xs text-studio-muted hover:text-white"
                onClick={() => onOpenChange(false)}
                data-testid="imagine-close"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {selected ? (
                <AssetImaginePanel
                  project={project}
                  character={selected}
                  embedded
                  onChanged={() => {
                    setReloadKey((n) => n + 1);
                    onChanged();
                  }}
                />
              ) : (
                <p className="text-sm text-studio-muted">Add a character on Assets, then open Grok Imagine.</p>
              )}
            </div>
          </div>
        </>
      ) : null}
      <div className="flex h-8 shrink-0 items-center gap-1 border-t border-studio-border px-2">
        <button
          type="button"
          data-testid="imagine-tab"
          aria-pressed={open}
          onClick={() => onOpenChange(!open)}
          className={`rounded-t-md px-3 py-1 text-xs ${
            open
              ? "bg-studio-raised font-medium text-white"
              : "text-studio-muted hover:bg-studio-raised hover:text-neutral-200"
          }`}
        >
          Grok Imagine
        </button>
      </div>
    </div>
  );
}
