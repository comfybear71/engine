"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InsertActionPanel from "@/components/InsertActionPanel";
import {
  lintScript,
  loadCharacters,
  loadScript,
  saveScript,
  type LintIssue,
} from "@/lib/worker";

function flattenLint(result: { lint: { errors: LintIssue[]; warnings: LintIssue[] } }): LintIssue[] {
  return [...result.lint.errors, ...result.lint.warnings];
}

export default function ScriptPanel({
  project,
  script = "script.txt",
  workerUp,
  selectedLine,
  onSelectLine,
  onSaved,
}: {
  project: string | null;
  script?: string;
  workerUp: boolean;
  selectedLine: number | null;
  onSelectLine: (line: number | null) => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linting, setLinting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [castNames, setCastNames] = useState<string[]>([]);
  const [castName, setCastName] = useState("Name");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!project || !workerUp) return;
    let cancelled = false;
    loadScript(project, script)
      .then((next) => {
        if (cancelled) return;
        setText(next);
        setDirty(false);
        setIssues([]);
        setStatus(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus(err.message);
      });
    loadCharacters(project)
      .then((characters) => {
        if (cancelled) return;
        const names = characters.map((c) => c.display_name || c.id);
        setCastNames(names);
        setCastName((current) => (names.includes(current) ? current : names[0] || "Name"));
      })
      .catch(() => {
        /* cast list is optional for editing */
      });
    return () => {
      cancelled = true;
    };
  }, [project, script, workerUp]);

  const lines = useMemo(() => text.split("\n"), [text]);

  useEffect(() => {
    if (selectedLine == null) return;
    const el = gutterRef.current?.querySelector(`[data-line="${selectedLine}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [selectedLine, lines.length]);

  const onSave = useCallback(async () => {
    if (!project || saving) return;
    setSaving(true);
    setStatus("Saving…");
    try {
      const result = await saveScript(project, text, script);
      setIssues(flattenLint(result));
      setDirty(false);
      setStatus(result.ok ? "Saved." : "Saved, with lint issues.");
      onSaved();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [project, script, saving, text, onSaved]);

  const onLint = useCallback(async () => {
    if (!project || linting) return;
    setLinting(true);
    setStatus("Linting…");
    try {
      const result = await lintScript(project, text, script);
      setIssues(flattenLint(result));
      setStatus(result.ok ? "Lint OK." : "Lint found issues.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Lint failed");
    } finally {
      setLinting(false);
    }
  }, [project, script, linting, text]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  function insertAtCursor(snippet: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const prefix = before.length && !before.endsWith("\n") ? "\n" : "";
    const next = `${before}${prefix}${snippet}\n${after}`;
    setText(next);
    setDirty(true);
    const cursor = start + prefix.length + snippet.length + 1;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  function syncScroll() {
    if (!textareaRef.current || !gutterRef.current) return;
    gutterRef.current.scrollTop = textareaRef.current.scrollTop;
  }

  if (!project) {
    return <div className="flex flex-1 items-center justify-center text-sm text-studio-muted">Pick a project to edit the script.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-studio-border px-3 py-2">
          <div className="text-xs text-studio-muted">
            {script} {dirty ? "· unsaved" : ""}
            {status ? <span className="ml-2 text-neutral-400">{status}</span> : null}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onLint()}
              disabled={!workerUp || linting}
              className="rounded-md border border-studio-border px-3 py-1 text-xs text-neutral-200 hover:text-white disabled:opacity-40"
            >
              {linting ? "Linting…" : "Lint"}
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={!workerUp || saving}
              className="rounded-md bg-studio-accent px-3 py-1 text-xs font-semibold text-black hover:bg-studio-accent-hover disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden bg-black/30">
          <div
            ref={gutterRef}
            className="w-12 shrink-0 overflow-hidden border-r border-studio-border bg-studio-panel py-2 text-right font-mono text-[11px] leading-6 text-studio-muted"
            aria-hidden
          >
            {lines.map((_, index) => {
              const n = index + 1;
              const active = selectedLine === n;
              return (
                <button
                  key={n}
                  type="button"
                  data-line={n}
                  onClick={() => onSelectLine(n)}
                  className={`block w-full px-2 ${active ? "bg-studio-accent/30 text-white" : "hover:text-neutral-200"}`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <textarea
            ref={textareaRef}
            className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-sm leading-6 text-neutral-100 outline-none"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setDirty(true);
            }}
            onScroll={syncScroll}
            onClick={(event) => {
              const el = event.currentTarget;
              const before = el.value.slice(0, el.selectionStart);
              onSelectLine(before.split("\n").length);
            }}
          />
        </div>

        <div className="max-h-28 overflow-auto border-t border-studio-border px-3 py-2 text-xs">
          {issues.length === 0 ? (
            <p className="text-studio-muted">No lint issues.</p>
          ) : (
            <ul className="space-y-1">
              {issues.map((issue, index) => (
                <li key={`${issue.level}-${issue.line}-${index}`}>
                  <button
                    type="button"
                    className={issue.level === "error" ? "text-red-400" : "text-amber-300"}
                    onClick={() => issue.line != null && onSelectLine(issue.line)}
                  >
                    {issue.level}
                    {issue.line != null ? ` · line ${issue.line}` : ""}: {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <InsertActionPanel
          castNames={castNames}
          selectedName={castName}
          onSelectName={setCastName}
          onInsert={insertAtCursor}
        />
      </div>
    </div>
  );
}
