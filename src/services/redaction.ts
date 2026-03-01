export type RedactionOptions = {
  maxChars: number;
  enabled: boolean;
};

export type RedactionResult = {
  full: string;
  preview: string;
  truncated: boolean;
  redactionApplied: boolean;
};

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_NUMBER_PATTERN = /\b\d{8,}\b/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._-]{10,}\b/gi;

export function redactAndTruncateContext(context: string, options: RedactionOptions): RedactionResult {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(100, Math.floor(options.maxChars)) : 4_000;
  const original = context.trim();

  let processed = original;
  let redactionApplied = false;

  if (options.enabled) {
    const replacements = [
      [EMAIL_PATTERN, "[redacted-email]"],
      [LONG_NUMBER_PATTERN, "[redacted-number]"],
      [OPENAI_KEY_PATTERN, "[redacted-key]"],
      [BEARER_PATTERN, "[redacted-token]"]
    ] as const;

    for (const [pattern, replacement] of replacements) {
      const next = processed.replace(pattern, replacement);
      if (next !== processed) {
        redactionApplied = true;
        processed = next;
      }
    }
  }

  const truncated = processed.length > maxChars;
  const full = truncated ? `${processed.slice(0, maxChars)}…` : processed;
  const previewMax = Math.min(280, maxChars);
  const preview = full.length > previewMax ? `${full.slice(0, previewMax)}…` : full;

  return {
    full,
    preview,
    truncated,
    redactionApplied
  };
}
