"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AssetFocus } from "@/lib/assetEditor";
import { encodeAssetDrag, ASSET_DRAG_MIME, slotLane, type AssetDrag } from "@/lib/stageAssets";
import { loadAssetsTreeOpen, saveAssetsTreeOpen } from "@/lib/stageLayout";
import {
  assetUrl,
  loadCharacters,
  loadProjectAudio,
  loadStaging,
  type Character,
  type CharacterSlot,
  type ProjectAudioFile,
  type Staging,
} from "@/lib/worker";
import type { LeftPoolId } from "@/components/StageRails";

type TreeKind = "characters" | "props" | "backgrounds" | "audio" | "sfx";

function groupsForPool(pool: LeftPoolId): TreeKind[] {
  if (pool === "media") return ["backgrounds", "audio"];
  if (pool === "effects") return ["sfx"];
  return ["characters", "props", "backgrounds", "audio", "sfx"];
}

function slotGroup(name: string): "mouths" | "faces" | "eyes" | "arms" | "bodies" | "other" {
  const n = name.toLowerCase();
  if (n === "mouth" || n.startsWith("mouth_")) return "mouths";
  if (n === "face" || n === "head" || n.startsWith("face_")) return "faces";
  if (n === "eyes" || n.startsWith("eye")) return "eyes";
  if (n.includes("hand") || n.includes("arm")) return "arms";
  if (n === "body") return "bodies";
  return "other";
}

const SLOT_GROUP_LABEL: Record<ReturnType<typeof slotGroup>, string> = {
  mouths: "Mouths",
  faces: "Faces",
  eyes: "Eyes",
  arms: "Arms",
  bodies: "Bodies",
  other: "Other",
};

function matchesQuery(label: string, query: string): boolean {
  if (!query) return true;
  return label.toLowerCase().includes(query);
}

function characterMatchesQuery(character: Character, query: string): boolean {
  if (matchesQuery(`${character.display_name} ${character.id}`, query)) return true;
  for (const slot of character.slots) {
    if (matchesQuery(slot.name, query)) return true;
    for (const drawing of slot.drawings) {
      if (matchesQuery(`${slot.name} ${drawing.name}`, query)) return true;
    }
    for (const cycleName of Object.keys(slot.cycles || {})) {
      if (matchesQuery(`${slot.name} ${cycleName}`, query)) return true;
    }
  }
  return false;
}

function startDrag(event: React.DragEvent, asset: AssetDrag) {
  const json = encodeAssetDrag(asset);
  event.dataTransfer.setData(ASSET_DRAG_MIME, json);
  event.dataTransfer.setData("text/plain", json);
  event.dataTransfer.effectAllowed = "copy";
}

function TinyThumb({ src, label }: { src: string | null; label: string }) {
  return (
    <span className="studio-asset-thumb" aria-hidden="true">
      {src ? (
        // Worker-served PNG/JPEG thumbs
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" />
      ) : (
        <span className="studio-asset-thumb-empty">{label.slice(0, 1)}</span>
      )}
    </span>
  );
}

function TreeToggle({
  id,
  label,
  open,
  onToggle,
  count,
}: {
  id: string;
  label: string;
  open: boolean;
  onToggle: (id: string, fallback?: boolean) => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      className="studio-asset-toggle"
      data-testid={`stage-assets-toggle-${id}`}
      aria-expanded={open}
      onClick={() => onToggle(id, open)}
    >
      <span className="studio-asset-chevron">{open ? "▾" : "▸"}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count != null ? <span className="text-[10px] text-neutral-600">{count}</span> : null}
    </button>
  );
}

function Leaf({
  testId,
  label,
  src,
  asset,
  draggable = true,
  selected = false,
  onOpen,
}: {
  testId: string;
  label: string;
  src: string | null;
  asset: AssetDrag;
  draggable?: boolean;
  selected?: boolean;
  onOpen?: () => void;
}) {
  return (
    <div
      className="studio-asset-leaf"
      data-testid={testId}
      data-draggable={draggable ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      draggable={draggable}
      title={draggable ? label : `${label} — listed only`}
      onDragStart={draggable ? (event) => startDrag(event, asset) : undefined}
      onClick={onOpen}
      onDoubleClick={onOpen}
    >
      <TinyThumb src={src} label={label} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

export default function StageAssetsPanel({
  project,
  workerUp,
  poolSection = "assets",
  refreshToken = 0,
  assetFocus = null,
  onOpenAsset,
}: {
  project: string | null;
  workerUp: boolean;
  poolSection?: LeftPoolId;
  refreshToken?: number;
  assetFocus?: AssetFocus | null;
  onOpenAsset?: (focus: AssetFocus) => void;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [staging, setStaging] = useState<Staging | null>(null);
  const [audio, setAudio] = useState<ProjectAudioFile[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({
    characters: true,
    audio: true,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen((current) => ({ ...current, ...loadAssetsTreeOpen() }));
  }, []);

  useEffect(() => {
    saveAssetsTreeOpen(open);
  }, [open]);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    Promise.all([loadCharacters(project), loadStaging(project), loadProjectAudio(project)])
      .then(([nextChars, nextStaging, nextAudio]) => {
        if (cancelled) return;
        setCharacters(nextChars);
        setStaging(nextStaging);
        setAudio(nextAudio);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, workerUp, refreshToken]);

  function toggle(id: string, fallback = true) {
    setOpen((current) => ({ ...current, [id]: !(current[id] == null ? fallback : current[id]) }));
  }

  function isOpen(id: string, fallback = true): boolean {
    return open[id] == null ? fallback : open[id];
  }

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => groupsForPool(poolSection), [poolSection]);

  if (!project) {
    return <div className="flex flex-1 items-center justify-center px-2 text-[11px] text-studio-muted">Pick a project.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="stage-assets-panel" data-section={poolSection}>
      <div className="shrink-0 border-b border-studio-border px-2 py-1.5">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search assets"
          aria-label="Search assets"
          data-testid="stage-assets-search"
          className="studio-asset-search"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {error ? <p className="px-1 text-[11px] text-red-400">{error}</p> : null}

        {visible.includes("characters") ? (
          <section>
            <TreeToggle id="characters" label="Characters" open={isOpen("characters")} onToggle={toggle} count={characters.length} />
            {isOpen("characters")
              ? characters
                  .filter((character) => characterMatchesQuery(character, q))
                  .map((character) => (
                    <CharacterBranch
                      key={character.id}
                      project={project}
                      character={character}
                      query={q}
                      isOpen={isOpen}
                      onToggle={toggle}
                      assetFocus={assetFocus}
                      onOpenAsset={onOpenAsset}
                    />
                  ))
              : null}
          </section>
        ) : null}

        {visible.includes("props") ? (
          <section>
            <TreeToggle id="props" label="Props" open={isOpen("props")} onToggle={toggle} count={staging?.props.length ?? 0} />
            {isOpen("props")
              ? (staging?.props || [])
                  .filter((prop) => matchesQuery(`${prop.id} ${prop.location}`, q))
                  .map((prop) => (
                    <Leaf
                      key={`${prop.location}:${prop.id}`}
                      testId={`stage-asset-prop-${prop.id}`}
                      label={`${prop.id} · ${prop.location}`}
                      src={assetUrl(project, prop.thumbRel, { thumb: true, v: prop.mtime })}
                      asset={{ kind: "prop", propId: prop.id, location: prop.location }}
                    />
                  ))
              : null}
          </section>
        ) : null}

        {visible.includes("backgrounds") ? (
          <section>
            <TreeToggle
              id="backgrounds"
              label="Backgrounds"
              open={isOpen("backgrounds")}
              onToggle={toggle}
              count={staging?.backgrounds.length ?? 0}
            />
            {isOpen("backgrounds")
              ? (staging?.backgrounds || [])
                  .filter((bg) => matchesQuery(bg.id, q))
                  .map((bg) => (
                    <Leaf
                      key={bg.id}
                      testId={`stage-asset-bg-${bg.id}`}
                      label={bg.id}
                      src={assetUrl(project, bg.thumbRel, { thumb: true, v: bg.mtime })}
                      asset={{ kind: "background", locationId: bg.id }}
                    />
                  ))
              : null}
          </section>
        ) : null}

        {visible.includes("audio") ? (
          <AudioBranch files={audio} query={q} isOpen={isOpen} onToggle={toggle} />
        ) : null}

        {visible.includes("sfx") ? (
          <section>
            <TreeToggle id="sfx" label="SFX / Music" open={isOpen("sfx", false)} onToggle={toggle} />
            {isOpen("sfx", false) ? (
              <p className="px-2 py-1 text-[10px] text-neutral-600" data-testid="stage-assets-sfx-placeholder">
                Coming later
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function CharacterBranch({
  project,
  character,
  query,
  isOpen,
  onToggle,
  assetFocus,
  onOpenAsset,
}: {
  project: string;
  character: Character;
  query: string;
  isOpen: (id: string, fallback?: boolean) => boolean;
  onToggle: (id: string, fallback?: boolean) => void;
  assetFocus?: AssetFocus | null;
  onOpenAsset?: (focus: AssetFocus) => void;
}) {
  const id = `char:${character.id}`;
  const grouped = new Map<ReturnType<typeof slotGroup>, CharacterSlot[]>();
  for (const slot of character.slots) {
    const group = slotGroup(slot.name);
    const list = grouped.get(group) || [];
    list.push(slot);
    grouped.set(group, list);
  }
  return (
    <div className="pl-1">
      <div
        className="studio-asset-leaf"
        data-testid={`stage-asset-character-${character.id}`}
        draggable
        title={character.display_name}
        onDragStart={(event) =>
          startDrag(event, { kind: "character", characterId: character.id, characterName: character.display_name })
        }
      >
        <button type="button" className="studio-asset-chevron" onClick={() => onToggle(id, false)} aria-expanded={isOpen(id, false)}>
          {isOpen(id, false) ? "▾" : "▸"}
        </button>
        <TinyThumb src={assetUrl(project, character.thumbRel, { thumb: true, v: character.mtime })} label={character.display_name} />
        <span className="min-w-0 flex-1 truncate">{character.display_name}</span>
      </div>
      {isOpen(id, false) || Boolean(query)
        ? (["mouths", "faces", "eyes", "arms", "bodies", "other"] as const).map((group) => {
            const slots = grouped.get(group);
            if (!slots || slots.length === 0) return null;
            const gid = `${id}:${group}`;
            const leaves = slotLeaves(project, character, slots, query, assetFocus, onOpenAsset);
            if (query && leaves.length === 0) return null;
            const showLeaves = isOpen(gid) || Boolean(query);
            return (
              <div key={group} className="pl-2">
                <TreeToggle id={gid} label={SLOT_GROUP_LABEL[group]} open={showLeaves} onToggle={onToggle} count={leaves.length} />
                {showLeaves ? leaves : null}
              </div>
            );
          })
        : null}
    </div>
  );
}

function slotLeaves(
  project: string,
  character: Character,
  slots: CharacterSlot[],
  query: string,
  assetFocus?: AssetFocus | null,
  onOpenAsset?: (focus: AssetFocus) => void
) {
  const out: ReactNode[] = [];
  for (const slot of slots) {
    const canDrop = slotLane(slot.name) != null;
    const slotLabel = slot.name;
    if (!query || matchesQuery(slotLabel, query) || slot.drawings.some((d) => matchesQuery(`${slot.name} ${d.name}`, query))) {
      out.push(
        <div
          key={`${slot.name}:slot`}
          className="studio-asset-leaf"
          data-testid={`stage-asset-slot-${character.id}-${slot.name}`}
          data-selected={assetFocus?.slot === slot.name && assetFocus.characterId === character.id && assetFocus.mode === "slot" && !assetFocus.view ? "true" : "false"}
          onClick={() => onOpenAsset?.({ mode: "slot", characterId: character.id, slot: slot.name })}
        >
          <span className="studio-asset-chevron" aria-hidden>
            ▸
          </span>
          <span className="min-w-0 flex-1 truncate">{slot.name}</span>
        </div>
      );
    }
    for (const [cycleName] of Object.entries(slot.cycles || {})) {
      const label = `${slot.name} ${cycleName}`;
      if (!matchesQuery(label, query)) continue;
      out.push(
        <Leaf
          key={`${slot.name}:cycle:${cycleName}`}
          testId={`stage-asset-cycle-${character.id}-${slot.name}-${cycleName}`}
          label={`${cycleName} · cycle`}
          src={assetUrl(project, slot.drawings[0]?.rel, { v: slot.drawings[0]?.mtime })}
          draggable={canDrop}
          asset={{
            kind: "cycle",
            characterId: character.id,
            characterName: character.display_name,
            slot: slot.name,
            cycle: cycleName,
          }}
        />
      );
    }
    for (const drawing of slot.drawings) {
      const label = `${slot.name} ${drawing.name}`;
      if (!matchesQuery(label, query)) continue;
      out.push(
        <Leaf
          key={`${slot.name}:${drawing.name}`}
          testId={`stage-asset-drawing-${character.id}-${slot.name}-${drawing.name}`}
          label={drawing.name}
          src={assetUrl(project, drawing.rel, { v: drawing.mtime })}
          draggable={canDrop}
          selected={
            assetFocus?.mode === "drawing" &&
            assetFocus.characterId === character.id &&
            assetFocus.slot === slot.name &&
            assetFocus.drawing === drawing.name
          }
          onOpen={() =>
            onOpenAsset?.({
              mode: "drawing",
              characterId: character.id,
              slot: slot.name,
              drawing: drawing.name,
            })
          }
          asset={{
            kind: "drawing",
            characterId: character.id,
            characterName: character.display_name,
            slot: slot.name,
            drawing: drawing.name,
          }}
        />
      );
    }
    for (const view of slot.views || []) {
      if (view.id === "front") continue;
      if (query && !matchesQuery(`${slot.name} ${view.id}`, query) && !view.drawings.some((d) => matchesQuery(d.name, query))) {
        continue;
      }
      out.push(
        <div
          key={`${slot.name}:view:${view.id}`}
          className="studio-asset-leaf"
          data-testid={`stage-asset-view-${character.id}-${slot.name}-${view.id}`}
          onClick={() => onOpenAsset?.({ mode: "slot", characterId: character.id, slot: slot.name, view: view.id })}
        >
          <span className="studio-asset-chevron" aria-hidden>
            ▸
          </span>
          <span className="min-w-0 flex-1 truncate">{view.id}</span>
        </div>
      );
      for (const drawing of view.drawings) {
        const label = `${slot.name} ${view.id} ${drawing.name}`;
        if (!matchesQuery(label, query)) continue;
        out.push(
          <Leaf
            key={`${slot.name}:${view.id}:${drawing.name}`}
            testId={`stage-asset-drawing-${character.id}-${slot.name}-${view.id}-${drawing.name}`}
            label={`${drawing.name} · ${view.id}`}
            src={assetUrl(project, drawing.rel, { v: drawing.mtime })}
            draggable={canDrop}
            onOpen={() =>
              onOpenAsset?.({
                mode: "drawing",
                characterId: character.id,
                slot: slot.name,
                drawing: drawing.name,
                view: view.id,
              })
            }
            asset={{
              kind: "drawing",
              characterId: character.id,
              characterName: character.display_name,
              slot: slot.name,
              drawing: drawing.name,
            }}
          />
        );
      }
    }
  }
  return out;
}

function AudioBranch({
  files,
  query,
  isOpen,
  onToggle,
}: {
  files: ProjectAudioFile[];
  query: string;
  isOpen: (id: string, fallback?: boolean) => boolean;
  onToggle: (id: string, fallback?: boolean) => void;
}) {
  const imported = files.filter((file) => file.kind === "imported" && matchesQuery(`${file.label} ${file.characterName}`, query));
  const generated = files.filter((file) => file.kind === "generated" && matchesQuery(`${file.label} ${file.characterName} ${file.rel}`, query));
  return (
    <section>
      <TreeToggle id="audio" label="Audio" open={isOpen("audio")} onToggle={onToggle} count={files.length} />
      {isOpen("audio") ? (
        <>
          <div className="pl-2">
            <TreeToggle id="audio:imported" label="Imported" open={isOpen("audio:imported")} onToggle={onToggle} count={imported.length} />
            {isOpen("audio:imported")
              ? imported.map((file) => (
                  <Leaf
                    key={file.rel}
                    testId={`stage-asset-audio-${file.label}`}
                    label={`${file.label} · ${file.characterName}`}
                    src={null}
                    asset={{
                      kind: "audio",
                      audioKind: "imported",
                      label: file.label,
                      characterId: file.characterId,
                      characterName: file.characterName,
                    }}
                  />
                ))
              : null}
          </div>
          <div className="pl-2">
            <TreeToggle id="audio:generated" label="Generated" open={isOpen("audio:generated")} onToggle={onToggle} count={generated.length} />
            {isOpen("audio:generated")
              ? generated.map((file) => (
                  <div
                    key={file.rel}
                    className="studio-asset-leaf"
                    data-draggable="false"
                    data-testid={`stage-asset-generated-${file.rel}`}
                    title="Generated line audio — already tied to a dialogue line"
                  >
                    <TinyThumb src={null} label={file.characterName} />
                    <span className="min-w-0 flex-1 truncate">
                      {file.label}/{file.rel.split("/").pop()}
                    </span>
                  </div>
                ))
              : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
