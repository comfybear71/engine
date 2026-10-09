"use client";

import { useMemo, useState, type ReactNode } from "react";
import { DrawerHeader } from "@/components/StageRails";
import {
  DEFAULT_CAMERA_FORM,
  buildCameraTag,
  findInsertAfterLine,
  insertLineAfter,
  type CameraMoveForm,
} from "@/lib/cameraTag";
import { saveScript, type LaneBlock } from "@/lib/worker";

export default function CameraDrawer({
  project,
  scriptName,
  scriptText,
  sceneId,
  playheadLine,
  cameraBlocks,
  selectedLine,
  onSeek,
  onSaved,
  onClose,
}: {
  project: string;
  scriptName: string;
  scriptText: string;
  sceneId: string | null;
  playheadLine: number | null;
  cameraBlocks: LaneBlock[];
  selectedLine: number | null;
  onSeek: (frame: number, scriptLine: number | null) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CameraMoveForm>(DEFAULT_CAMERA_FORM);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const shotMoves = useMemo(
    () => cameraBlocks.filter((block) => (sceneId ? block.sceneId === sceneId : true)),
    [cameraBlocks, sceneId]
  );

  function setField<K extends keyof CameraMoveForm>(key: K, value: CameraMoveForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onAdd() {
    const built = buildCameraTag(form);
    if (!built.ok) {
      setStatus(built.error);
      return;
    }
    setSaving(true);
    setStatus("Saving…");
    try {
      const after = findInsertAfterLine(scriptText, playheadLine, sceneId);
      const next = insertLineAfter(scriptText, after, built.tag);
      const result = await saveScript(project, next, scriptName);
      setStatus(result.ok ? "Inserted and saved." : "Saved, with lint issues.");
      setForm(DEFAULT_CAMERA_FORM);
      onSaved();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="camera-drawer">
      <DrawerHeader title="Camera" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-[11px] text-studio-muted">
          {sceneId ? `Shot ${sceneId}` : "All shots"} · [Camera:] tags on the script. The Camera lane shows these moves.
        </p>
        <ul className="mb-4 space-y-1">
          {shotMoves.map((block) => {
            const active = selectedLine != null && block.scriptLine === selectedLine;
            return (
              <li key={block.id}>
                <button
                  type="button"
                  onClick={() => onSeek(block.startFrame, block.scriptLine)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                    active ? "bg-studio-accent/20 text-white" : "text-neutral-300 hover:bg-studio-raised"
                  }`}
                >
                  <span className="truncate">{block.label}</span>
                  <span className="ml-2 shrink-0 font-mono text-[10px] text-studio-muted">
                    {block.scriptLine ? `L${block.scriptLine}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {shotMoves.length === 0 ? (
            <li className="text-sm text-studio-muted">No camera moves in this shot.</li>
          ) : null}
        </ul>

        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-studio-muted">
          Add camera move
        </h4>
        <div className="space-y-2">
          <Field label="zoom">
            <input
              className="studio-field"
              value={form.zoom}
              disabled={form.reset}
              placeholder="1.3"
              onChange={(event) => setField("zoom", event.target.value)}
              data-testid="camera-zoom"
            />
          </Field>
          <Field label="pan">
            <input
              className="studio-field"
              value={form.pan}
              disabled={form.reset}
              placeholder="960,540"
              onChange={(event) => setField("pan", event.target.value)}
              data-testid="camera-pan"
            />
          </Field>
          <Field label="tilt">
            <input
              className="studio-field"
              value={form.tilt}
              disabled={form.reset}
              placeholder="80"
              onChange={(event) => setField("tilt", event.target.value)}
              data-testid="camera-tilt"
            />
          </Field>
          <Field label="to">
            <input
              className="studio-field"
              value={form.to}
              disabled={form.reset}
              placeholder="960,820"
              onChange={(event) => setField("to", event.target.value)}
              data-testid="camera-to"
            />
          </Field>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={form.reset}
              onChange={(event) => setField("reset", event.target.checked)}
              data-testid="camera-reset"
            />
            reset
          </label>
          <Field label="over">
            <input
              className="studio-field"
              value={form.over}
              placeholder="2s"
              onChange={(event) => setField("over", event.target.value)}
              data-testid="camera-over"
            />
          </Field>
          <Field label="ease">
            <select
              className="studio-field"
              value={form.ease}
              onChange={(event) => setField("ease", event.target.value === "inout" ? "inout" : "linear")}
              data-testid="camera-ease"
            >
              <option value="linear">linear</option>
              <option value="inout">inout</option>
            </select>
          </Field>
          <button
            type="button"
            data-testid="camera-add"
            disabled={saving}
            onClick={() => void onAdd()}
            className="w-full rounded-md bg-studio-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
          >
            {saving ? "Saving…" : "Add camera move"}
          </button>
          {status ? <p className="text-[11px] text-studio-muted">{status}</p> : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-studio-muted">
      <span className="w-10 shrink-0">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}
