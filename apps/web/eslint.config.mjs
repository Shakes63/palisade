import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

// `next lint` is deprecated in Next 15 and gone in 16, and it took the whole repo's
// `pnpm lint` down with it: with no config present it dropped into an interactive
// setup prompt, which never answers in CI. This is the ESLint CLI equivalent.
// eslint-config-next is still eslintrc-shaped, hence FlatCompat.
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "app/docs/games/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
