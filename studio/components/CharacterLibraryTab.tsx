"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mergeCategories } from "@/lib/actionLibrary";
import {
  assetUrl,
  importFactoryMp4,
  loadCharacterLibrary,
  type CharacterLibrary,
  type LibraryClip,
} from "@/lib/worker";

export default function CharacterLibraryTab({
  project,
  characterId,
  onImported,
}: {
  project: string;
  characterId: string;
  onImported: () => void;
}) {
  const [library, setLibrary] = useState<CharacterLibrary | null>(null);
  const [kind, setKind] = useState("all");
  const [action, setAction] = useState("all");
  const [view, setView] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadCharacterLibrary(project, characterId)
      .then((next) => {
        if (!cancelled) setLibrary(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Library failed");
      });
    return () => {
      cancelled = true;
    };
  }, [project, characterId]);

  const clips = useMemo(() => {
    const list = library?.clips || [];
    return list.filter((clip) => {
      if (kind !== "all" && clip.kind !== kind) return false;
      if (action !== "all" && clip.action !== action && clip.category !== action) return false;
      if (view !== "all" && clip.view !== view && !(clip.frames || []).some((frame) => frame.view === view)) return false;
      return true;
    });
  }, [library, kind, action, view]);

  const actions = [...new Set((library?.clips || []).map((clip) => clip.action).filter(Boolean))];
  const views = [...new Set((library?.clips || []).flatMap((clip) => clip.frames.map((frame) => frame.view).filter(Boolean)))];

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importFactoryMp4(project, { characterId, file, prompt: file.name.replace(/\.[^.]+$/, "") });
      const next = await loadCharacterLibrary(project, characterId);
      setLibrary(next);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import MP4 failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="studio-factory-library-tab" data-testid="assets-library-tab">
      <div className="studio-factory-library-filters">
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="assets-library-kind">
            <option value="all">All</option>
            <option value="body">Body</option>
            <option value="head">Head</option>
          </select>
        </label>
        <label>
          Action
          <select value={action} onChange={(event) => setAction(event.target.value)} data-testid="assets-library-action">
            <option value="all">All</option>
            {actions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          View
          <select value={view} onChange={(event) => setView(event.target.value)} data-testid="assets-library-view">
            <option value="all">All</option>
            {views.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/*"
          className="hidden"
          data-testid="assets-library-file"
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>
      {error ? <p className="mb-2 text-[11px] text-red-400">{error}</p> : null}
      <div className="studio-factory-library-clips">
        <button
          type="button"
          className="studio-factory-add"
          data-testid="assets-library-import"
          data-wide="false"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          title="Import MP4"
        >
          <span>{busy ? "…" : "+"}</span>
          <em>Import MP4</em>
        </button>
        {clips.length === 0 ? (
          <p className="text-[11px] text-studio-muted">Import an MP4 to fill this character’s action pack.</p>
        ) : null}
        {clips.map((clip) => (
          <ClipStrip key={clip.id} project={project} clip={clip} />
        ))}
      </div>
    </div>
  );
}

function ClipStrip({ project, clip }: { project: string; clip: LibraryClip }) {
  const cats = mergeCategories();
  const label = cats.find((item) => item.id === clip.category)?.label || clip.category;
  return (
    <section className="studio-factory-library-clip" data-testid={`assets-library-clip-${clip.id}`}>
      <header>
        <strong>{clip.id}</strong>
        <span>
          {clip.kind} · {label} · {clip.frameCount} frames
        </span>
        {clip.warnings.length ? <em title={clip.warnings.join(" ")}>warning</em> : null}
      </header>
      <div className="studio-factory-import-strip">
        {clip.frames.map((frame) => (
          <figure key={frame.index} className="studio-factory-import-cell" data-testid={`assets-library-frame-${clip.id}-${frame.index}`}>
            {frame.thumbRel || frame.rel ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={assetUrl(project, frame.thumbRel || frame.rel, { factory: true })} alt="" />
            ) : null}
            <span>{String(frame.index).padStart(2, "0")}</span>
            {frame.issues && frame.issues.length ? <i>!</i> : null}
          </figure>
        ))}
      </div>
    </section>
  );
}
