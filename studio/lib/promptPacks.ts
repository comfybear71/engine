import rodney from "../../docs/prompt-packs/rodney.json";

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
