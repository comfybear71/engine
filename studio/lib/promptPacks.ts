import rodney from "../../docs/prompt-packs/rodney.json" with { type: "json" };

export type PackDest =
  | { kind: "file"; rel: string }
  | { kind: "slot"; slot: string; drawings_dir: string; child?: string }
  | { kind: "prop" }
  | { kind: "background" }
  | { kind: "reference" }
  | null;

export type PromptPackSet = {
  id: string;
  group?: string;
  label: string;
  description: string;
  needId?: string;
  prompt: string;
  split?: "grid" | "components";
  grid?: { cols: number; rows: number };
  assignChoices?: string[];
  cells?: { name: string; dest?: PackDest; cycle?: string }[];
};

export type PromptPack = {
  id: string;
  characterIds: string[];
  displayNames?: string[];
  displayName: string;
  styleBlock: string;
  sets: PromptPackSet[];
};

export const PROMPT_PACKS: PromptPack[] = [rodney as PromptPack];

function norm(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function packForCharacter(character: { id?: string; display_name?: string } | null): PromptPack | null {
  if (!character) return null;
  const id = norm(character.id);
  const display = norm(character.display_name);
  return (
    PROMPT_PACKS.find((pack) => {
      const ids = (pack.characterIds || [pack.id]).map(norm);
      const names = (pack.displayNames || (pack.displayName ? [pack.displayName] : [])).map(norm);
      return (id && ids.includes(id)) || (display && names.includes(display));
    }) || null
  );
}

export function fillPackPrompt(
  set: PromptPackSet,
  vars: { name: string; styleBlock: string }
): string {
  return String(set.prompt || "")
    .replaceAll("{{styleBlock}}", vars.styleBlock)
    .replaceAll("{{name}}", vars.name);
}

export function ingestNeedId(set: PromptPackSet): string {
  return set.needId || set.id;
}

export const CUSTOM_NEED_ID = "custom";

export const CUSTOM_MOUTH_NAMES = [
  "X",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "B_loud",
  "C_loud",
  "D_loud",
  "E_loud",
] as const;

export function composeCustomPrompt(styleBlock: string, userText: string): string {
  const style = String(styleBlock || "").trim();
  const user = String(userText || "").trim();
  if (style && user) return `${style}\n\n${user}`;
  return style || user;
}

export function customCellName(index: number, slot: string): string {
  if (String(slot || "") === "mouth" && CUSTOM_MOUTH_NAMES[index]) return CUSTOM_MOUTH_NAMES[index];
  return `cell_${String(index).padStart(2, "0")}`;
}

export type CustomSlotChoice = { slot: string; drawings_dir: string; label: string };

const FALLBACK_SLOTS: CustomSlotChoice[] = [
  { slot: "mouth", drawings_dir: "mouth", label: "mouth" },
  { slot: "mouth", drawings_dir: "mouth_front", label: "mouth · front" },
  { slot: "mouth", drawings_dir: "mouth_left_34", label: "mouth · left 3/4" },
  { slot: "mouth", drawings_dir: "mouth_left_side", label: "mouth · left side" },
  { slot: "mouth", drawings_dir: "mouth_right_34", label: "mouth · right 3/4" },
  { slot: "mouth", drawings_dir: "mouth_right_side", label: "mouth · right side" },
  { slot: "mouth", drawings_dir: "mouth_up", label: "mouth · up" },
  { slot: "mouth", drawings_dir: "mouth_down", label: "mouth · down" },
  { slot: "face", drawings_dir: "face", label: "face" },
  { slot: "eyes", drawings_dir: "eyes", label: "eyes" },
  { slot: "head", drawings_dir: "head", label: "head" },
  { slot: "body", drawings_dir: "body", label: "body" },
  { slot: "right_hand", drawings_dir: "right_hand", label: "right_hand" },
  { slot: "mic_arm", drawings_dir: "mic_arm", label: "mic_arm" },
];

export function customSlotChoices(
  character: { slots?: { name: string; drawingsDir?: string; owner?: string | null }[] } | null
): CustomSlotChoice[] {
  const seen = new Set<string>();
  const out: CustomSlotChoice[] = [];
  function add(slot: string, drawings_dir: string, label: string) {
    const key = `${slot}:${drawings_dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ slot, drawings_dir, label });
  }
  for (const item of FALLBACK_SLOTS) add(item.slot, item.drawings_dir, item.label);
  for (const slot of character?.slots || []) {
    const dir = slot.drawingsDir || slot.name;
    const label = slot.owner ? `${slot.name} on ${slot.owner}` : slot.name;
    add(slot.name, dir, label);
  }
  return out;
}
