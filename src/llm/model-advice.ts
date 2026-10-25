/**
 * Is this model able to do the one thing the agent needs?
 *
 * Every useful call in this extension is `completeStructured` — parse a resume,
 * score a posting, answer a screening question — and all of them demand a
 * strict JSON object back. A model that writes fluent prose but will not hold a
 * JSON contract is not "a bit worse" here, it is unusable: the reply fails to
 * parse, the schema fills in its defaults, and the user gets an empty profile
 * with no error.
 *
 * Nothing here names a specific model, deliberately. Providers retire them on
 * their own schedule — NVIDIA retired meta/llama-3.1-70b-instruct in August
 * 2026 while every guide, including this file's first version, still
 * recommended it. Advice that names a model has a shelf life; advice that
 * describes a shape, and points at the live catalogue, does not.
 *
 * The check is a name heuristic because it has to run while the user is typing,
 * before any request is made. The JSON round-trip on the connection test is the
 * authoritative one; this exists to catch the mistake where it is made.
 */

export type ModelVerdict = {
  level: 'bad' | 'warn' | 'ok'
  message: string
}

/** Names that mark a model as instruction-tuned, which is what we need. */
const INSTRUCT_MARKERS = ['instruct', '-it', 'chat', 'nemotron', 'hermes', 'tulu', 'dolphin']

/**
 * What to tell the user instead of a model name.
 *
 * "List available models" asks their key what it can actually call, which is
 * the only source that cannot go stale.
 */
export const PICK_A_MODEL_HINT =
  'Press "List available models" to see what this key can call, and pick one with "instruct" in its name.'

import { isWebDriver } from './chat-sites'

export function assessModel(driver: string, model: string): ModelVerdict | null {
  if (isWebDriver(driver)) return null
  const name = String(model ?? '')
    .trim()
    .toLowerCase()
  if (!name) return null

  // Diffusion language models generate by iterative denoising rather than
  // left-to-right decoding, and do not reliably terminate a JSON object.
  if (name.includes('diffusion')) {
    return {
      level: 'bad',
      message: `Diffusion models do not follow a strict JSON contract — they return prose, which this extension cannot use for anything. ${PICK_A_MODEL_HINT}`,
    }
  }

  // Base (non-instruction-tuned) checkpoints continue text rather than answer,
  // so they tend to echo the prompt or ramble past the closing brace.
  if (!INSTRUCT_MARKERS.some((marker) => name.includes(marker))) {
    return {
      level: 'warn',
      message: `This does not look like an instruction-tuned model. Base models often ignore the JSON format this extension requires. ${PICK_A_MODEL_HINT}`,
    }
  }

  return { level: 'ok', message: 'Instruction-tuned — should hold the JSON format the agent needs.' }
}
