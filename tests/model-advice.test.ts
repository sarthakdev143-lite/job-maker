/**
 * The model picker has to catch an unusable model at the moment it is typed.
 *
 * Every real call in this extension is completeStructured. A model that will
 * not return strict JSON does not degrade gracefully here — it produces empty
 * profiles and empty answers with no error, which is indistinguishable from the
 * extension being broken.
 */

import { describe, expect, it } from 'vitest'

import { assessModel, PICK_A_MODEL_HINT } from '@/llm/model-advice'

describe('assessModel', () => {
  it('says nothing for the web driver, which has no model field', () => {
    expect(assessModel('deepseek-web', '')).toBeNull()
    expect(assessModel('deepseek-web', 'anything')).toBeNull()
  })

  it('says nothing for an empty box, which is a user mid-typing', () => {
    expect(assessModel('nvidia-nim', '')).toBeNull()
    expect(assessModel('nvidia-nim', '   ')).toBeNull()
  })

  it('rejects diffusion models outright', () => {
    const verdict = assessModel('nvidia-nim', 'google/diffusiongemma-instruct')
    expect(verdict?.level).toBe('bad')
    expect(verdict?.message).toMatch(/diffusion/i)
    // The message has to say what to do instead, not just what is wrong.
    expect(verdict?.message).toContain(PICK_A_MODEL_HINT)
  })

  it.each([
    'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-405b-instruct',
    'mistralai/mixtral-8x22b-instruct-v0.1',
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'google/gemma-2-27b-it',
  ])('accepts the instruction-tuned model %s', (model) => {
    expect(assessModel('nvidia-nim', model)?.level).toBe('ok')
  })

  it('warns about a base checkpoint with no instruct marker', () => {
    const verdict = assessModel('nvidia-nim', 'meta/llama-3.1-70b')
    expect(verdict?.level).toBe('warn')
    expect(verdict?.message).toContain(PICK_A_MODEL_HINT)
  })

  it('is case insensitive, since model ids are pasted in as found', () => {
    expect(assessModel('nvidia-nim', 'Meta/Llama-3.1-70B-Instruct')?.level).toBe('ok')
    expect(assessModel('nvidia-nim', 'Google/DiffusionGemma')?.level).toBe('bad')
  })

  it('applies to every API driver, not just NIM', () => {
    expect(assessModel('openai-compatible', 'some-base-model')?.level).toBe('warn')
    expect(assessModel('anthropic-api', 'claude-sonnet-5')).not.toBeNull()
  })

  it('never names a specific model, which is how this advice went stale', () => {
    // meta/llama-3.1-70b-instruct was recommended here and retired by NVIDIA in
    // August 2026, so the guidance sent users straight into an HTTP 410.
    const messages = [
      assessModel('nvidia-nim', 'google/diffusiongemma')?.message ?? '',
      assessModel('nvidia-nim', 'meta/llama-3.1-70b')?.message ?? '',
      PICK_A_MODEL_HINT,
    ]
    for (const message of messages) {
      expect(message).not.toMatch(/llama-3\.\d|mixtral|nemotron-\d/i)
    }
  })
})
