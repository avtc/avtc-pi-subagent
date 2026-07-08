// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Hook arrays for pi-subagent — shared between extension.ts and index.ts.
 *
 * Extension.ts exposes add* methods that push to these arrays.
 * Index.ts reads from them at execution time.
 * Arrays are cleared on session_start before re-emitting :ready.
 */

import type { ModelResolverHook } from "./model-resolution.js";

export const _promptTransformers: Array<
  (
    systemPrompt: string,
    context: {
      agentName: string;
      task?: string;
      isFork: boolean;
    },
  ) => string | Promise<string>
> = [];
export const _modelResolvers: ModelResolverHook[] = [];
