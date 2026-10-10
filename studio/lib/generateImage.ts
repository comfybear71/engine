export function explainGenerateError(message: string): string {
  const raw = String(message || "");
  if (/XAI_API_KEY is missing|API key is missing/i.test(raw)) {
    return "The xAI API key is missing. Open Settings and paste your key, then try again.";
  }
  if (/rejected the API key/i.test(raw)) {
    return "xAI rejected the API key. Open Settings and paste a valid key.";
  }
  if (/rate limit/i.test(raw)) {
    return "xAI rate limit — wait a minute and try again.";
  }
  if (/refused this prompt|content policy/i.test(raw)) {
    return "xAI refused this prompt (content policy). Change the prompt and try again.";
  }
  if (/credits are used up/i.test(raw)) {
    return "xAI credits are used up. Add credits on the xAI console, then try again.";
  }
  return raw || "Could not generate the image.";
}

export function summarizeGenerateCost(body: {
  creditNote?: string;
  estimatedCost?: number | null;
  estimatedCostLabel?: string | null;
  n?: number;
}): { creditNote: string; estimatedCost: string | null } {
  const note = String(body.creditNote || "This uses xAI credits.").replace(/\s+/g, " ").trim();
  const label =
    body.estimatedCostLabel ||
    (typeof body.estimatedCost === "number" && Number.isFinite(body.estimatedCost)
      ? `about $${body.estimatedCost.toFixed(body.estimatedCost >= 1 ? 2 : 3)}`
      : null);
  return { creditNote: note, estimatedCost: label };
}
