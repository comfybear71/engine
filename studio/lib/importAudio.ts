export const AUDIO_ACCEPT = ".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav,audio/wave";

export const IMPORT_AUDIO_STAGES = [
  { id: "convert", label: "Converting the recording" },
  { id: "mouth", label: "Making mouth shapes" },
  { id: "transcribe", label: "Transcribing speech" },
] as const;

export type ImportAudioStageId = (typeof IMPORT_AUDIO_STAGES)[number]["id"];

export type ImportAudioResult = {
  ok: boolean;
  dryRun: boolean;
  noTranscribe: boolean;
  label: string;
  character: string;
  durationSeconds: number;
  creditNote: string;
  wavPath?: string;
  cuesPath?: string;
  wordsPath?: string;
  transcribed?: boolean;
  tag?: string;
  tags?: string[];
  split?: boolean;
  willSplit?: boolean;
  estimatedChunks?: number | null;
  chunks?: { label: string; offsetSec: number; durationSec?: number }[];
  estimatedCost?: string | number | null;
  cost?: string | number | null;
  estimatedCredits?: string | number | null;
  creditEstimate?: string | number | null;
};

export type DryRunSummary = {
  durationLabel: string;
  usesCredits: boolean;
  creditNote: string;
  estimatedCost: string | null;
};

const AUDIO_EXT = new Set([".mp3", ".wav"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);

export function slugifyImportLabel(text: string): string {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function suggestedLabelFromFilename(filename: string): string {
  const base = String(filename || "").replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  return slugifyImportLabel(base);
}

export function buildAudioTag(characterName: string, label: string): string {
  const name = String(characterName || "").trim() || "Name";
  const file = slugifyImportLabel(label) || "take";
  return `[Audio: ${name} file=${file}]`;
}

export const SPLIT_OVER_SEC = 60;

export function shouldOfferSplit(durationSeconds: number): boolean {
  return Number(durationSeconds) > SPLIT_OVER_SEC + 0.01;
}

export function formatAudioAtTime(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 0.005) return "0s";
  const rounded = Math.round(s * 100) / 100;
  return `${rounded}s`;
}

export function parseAtTimeToSeconds(raw: string, fps = 24): number {
  const text = String(raw || "").trim();
  if (!text) return 0;
  if (/s$/i.test(text)) return Math.max(0, Number.parseFloat(text) || 0);
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return 0;
  if (text.includes(".")) return Math.max(0, n);
  return Math.max(0, n / Math.max(1, fps));
}

export type AudioChunkTag = { label: string; offsetSec: number };

export function buildChunkAudioTags(
  characterName: string,
  chunks: AudioChunkTag[],
  opts?: { view?: string | null; baseOffsetSec?: number }
): string[] {
  const name = String(characterName || "").trim() || "Name";
  const view = opts?.view ? ` view=${opts.view}` : "";
  const base = opts?.baseOffsetSec || 0;
  return chunks.map(
    (chunk) =>
      `[Audio: ${name} file=${slugifyImportLabel(chunk.label) || "take"}${view} at_time=${formatAudioAtTime(base + chunk.offsetSec)}]`
  );
}

export function replaceLineWithAudioChunks(
  line: string,
  chunks: AudioChunkTag[],
  fps = 24
): string[] | null {
  if (!chunks.length) return null;
  const audio = line.match(/^(\s*)\[Audio:\s*(\S+)(.*?)\]\s*$/i);
  if (audio) {
    const rest = audio[3] || "";
    const view = (rest.match(/\bview=(\S+)/i) || [])[1] || null;
    const at = rest.match(/\b(?:at_time|start)=(\S+)/i);
    const base = at ? parseAtTimeToSeconds(at[1], fps) : 0;
    return buildChunkAudioTags(audio[2], chunks, { view, baseOffsetSec: base }).map(
      (tag) => `${audio[1]}${tag}`
    );
  }
  const dialogue = line.match(/^(\s*)(.+?)(\s*:\s*)(.*)$/);
  if (!dialogue) return null;
  const head = dialogue[2];
  const name = head.replace(/\s+\b(?:at_time|start|view|trim_in|trim_out)=\S+/gi, "").trim();
  const view = (head.match(/\bview=(\S+)/i) || [])[1] || null;
  const at = head.match(/\b(?:at_time|start)=(\S+)/i);
  const base = at ? parseAtTimeToSeconds(at[1], fps) : 0;
  return buildChunkAudioTags(name || "Name", chunks, { view, baseOffsetSec: base }).map(
    (tag) => `${dialogue[1]}${tag}`
  );
}

export function formatAudioLength(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(s);
  const minutes = Math.floor(whole / 60);
  const rem = whole % 60;
  const tenths = Math.round(s * 10) / 10;
  if (minutes <= 0) return `${tenths}s`;
  return `${minutes}m ${String(rem).padStart(2, "0")}s`;
}

function formatCostValue(value: string | number | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1 && value > 0 ? `about $${value.toFixed(3)}` : `about $${value.toFixed(2)}`;
  }
  const text = String(value).trim();
  return text || null;
}

export function summarizeDryRun(
  result: Pick<
    ImportAudioResult,
    "durationSeconds" | "creditNote" | "noTranscribe" | "estimatedCost" | "cost" | "estimatedCredits" | "creditEstimate"
  >,
  opts?: { noTranscribe?: boolean }
): DryRunSummary {
  const noTranscribe = opts?.noTranscribe ?? !!result.noTranscribe;
  const durationLabel = formatAudioLength(result.durationSeconds);
  const estimatedCost =
    formatCostValue(result.estimatedCost) ||
    formatCostValue(result.cost) ||
    formatCostValue(result.estimatedCredits) ||
    formatCostValue(result.creditEstimate);
  if (noTranscribe) {
    return {
      durationLabel,
      usesCredits: false,
      creditNote: `Audio length: ${durationLabel}. Transcription will be skipped — no ElevenLabs speech-to-text credits.`,
      estimatedCost: null,
    };
  }
  const fromApi = String(result.creditNote || "")
    .replace(/\s*Use --no-transcribe to skip STT\.?/gi, "")
    .replace(/\s*\(--no-transcribe\)/gi, "")
    .trim();
  return {
    durationLabel,
    usesCredits: true,
    creditNote:
      fromApi ||
      `Audio length: ${durationLabel}. Speech-to-text uses ElevenLabs credits (billed by how long the recording is).`,
    estimatedCost,
  };
}

export function acceptAudioFile(file: { name: string; type?: string } | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!file || !file.name) {
    return { ok: false, error: "Drop an mp3 or wav recording, or click to pick one." };
  }
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  const type = String(file.type || "").toLowerCase();
  if (AUDIO_EXT.has(ext) || AUDIO_TYPES.has(type)) return { ok: true };
  return { ok: false, error: "That file is not an mp3 or wav. Pick a different recording." };
}

export function explainImportAudioError(raw: string): string {
  const message = String(raw || "").trim() || "Import failed.";
  if (/ELEVENLABS_API_KEY|rejected the API key/i.test(message)) {
    return "The ElevenLabs API key is missing or was rejected. Open the engine folder’s .env file, add ELEVENLABS_API_KEY, then try again.";
  }
  if (/quota|payment required|out of credits|402/i.test(message)) {
    return "ElevenLabs says there are not enough speech-to-text credits. Add credits, or tick Skip transcription and import again.";
  }
  if (/Rhubarb not found|RHUBARB_PATH/i.test(message)) {
    return "The mouth-shape tool (Rhubarb) is not installed on this computer. The recording can still be used, but lips will not move until Rhubarb is set up.";
  }
  if (/Unsupported audio type/i.test(message)) {
    return "That file is not an mp3 or wav. Pick a different recording.";
  }
  if (/Unknown character/i.test(message)) {
    return message.replace(/\s*\(--character[^)]*\)/g, "").replace(/\s+--character\s+\S+/g, "").trim();
  }
  if (/Upload too large/i.test(message)) {
    return "That file is too big (maximum 200 MB).";
  }
  if (/Audio file not found/i.test(message)) {
    return "The recording could not be read. Try dropping the file again.";
  }
  if (/ffmpeg/i.test(message)) {
    return "Could not convert the recording. Check that FFmpeg is installed, then try again.";
  }
  if (/character is required/i.test(message)) {
    return "Pick a character before importing.";
  }
  if (/Import label is empty|Invalid import label/i.test(message)) {
    return "The label is empty. Use letters or numbers (spaces are fine).";
  }
  return message
    .replace(/\s*Use --no-transcribe to skip STT\.?/gi, "")
    .replace(/\s+--(?:dry-run|no-transcribe|name|character)\b/gi, "")
    .trim();
}
