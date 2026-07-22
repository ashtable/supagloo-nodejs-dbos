import {
  type AiGenerationKind,
  GeneratedScriptSchema,
  GeneratedStoryboardSchema,
} from "@supagloo/database-lib";
import type { z } from "zod";
import { UnsupportedGenerationKindError } from "./errors";

/**
 * Select the target structured-output Zod schema for a generation `kind` (design-delta §7
 * workflow 5 — one workflow handles BOTH text kinds, choosing the schema by the request
 * row's `kind`). `storyboard` → the full scene breakdown; `script` → single-scene text.
 * Any other (media) kind is not this workflow's concern (#32–34) and is rejected loudly.
 */
export function selectResultSchema(kind: AiGenerationKind): z.ZodType<unknown> {
  switch (kind) {
    case "storyboard":
      return GeneratedStoryboardSchema;
    case "script":
      return GeneratedScriptSchema;
    default:
      throw new UnsupportedGenerationKindError(kind);
  }
}
