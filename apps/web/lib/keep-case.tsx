import type { ReactNode } from "react";

// Brand names and in-game commands that an uppercase label or heading would misspell.
const CASED = /(pfSense|UniFi|AuthKey|(?<=^|[\s(])\/[A-Za-z]\w*)/;

export function keepCase(text: string): ReactNode {
  const parts = text.split(CASED);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 ? (
      <span key={i} className="normal-case">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
