"use client";

import { useState } from "react";
import { assetUrl, saveCharacterReference, type Character } from "@/lib/worker";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

export default function CharacterReferenceCard({
  project,
  character,
  onChanged,
}: {
  project: string;
  character: Character;
  onChanged: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = assetUrl(project, character.referenceRel, { v: character.referenceMtime });

  async function onFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Drop a PNG or JPEG. It is stored as-is, not cut out.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await fileToBase64(file);
      await saveCharacterReference(project, character.id, { imageBase64, filename: file.name });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save reference");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-white">Full-body reference</h4>
        <span className="text-[11px] text-studio-muted">original, no cut-out</span>
      </div>
      {src ? (
        <div className="studio-checker relative aspect-[3/4] overflow-hidden rounded-md border border-studio-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={`${character.display_name} reference`} className="h-full w-full object-contain" />
        </div>
      ) : (
        <p className="text-[11px] text-studio-muted">None yet. Drop or paste a finished full-body drawing, including the head.</p>
      )}
      <label
        data-reference-drop="1"
        tabIndex={0}
        className={`flex min-h-[72px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-3 text-center text-[11px] outline-none ${
          dragging ? "border-studio-accent bg-studio-accent/10 text-white" : "border-studio-border text-studio-muted"
        } ${busy ? "pointer-events-none opacity-50" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) void onFile(file);
        }}
        onPaste={(event) => {
          const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
          const file = item?.getAsFile();
          if (!file) return;
          event.preventDefault();
          event.stopPropagation();
          void onFile(file);
        }}
      >
        {busy ? "Saving…" : "Drop or paste a full-body reference"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
            event.target.value = "";
          }}
        />
      </label>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </section>
  );
}
