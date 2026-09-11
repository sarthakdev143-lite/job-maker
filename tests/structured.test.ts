import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { StructuredParseError, extractJsonCandidate, parseLoose, parseStructured, repairJson } from '@/llm/structured'

describe('extractJsonCandidate', () => {
  it('pulls JSON out of a fenced block wrapped in prose', () => {
    const reply = 'Sure! Here you go:\n\n```json\n{"score": 82}\n```\n\nLet me know if you want changes.'
    expect(extractJsonCandidate(reply)).toBe('{"score": 82}')
  })

  it('takes the last block when the model corrects itself', () => {
    const reply = '```json\n{"score": 1}\n```\nActually:\n```json\n{"score": 2}\n```'
    expect(extractJsonCandidate(reply)).toBe('{"score": 2}')
  })

  it('finds bare JSON with no fence', () => {
    expect(extractJsonCandidate('The answer is {"a": 1} I think')).toBe('{"a": 1}')
  })

  it('respects braces inside string values', () => {
    expect(extractJsonCandidate('{"a": "} not the end"}')).toBe('{"a": "} not the end"}')
  })

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonCandidate('I cannot help with that.')).toBeNull()
  })
})

describe('repairJson', () => {
  it('removes trailing commas', () => {
    expect(JSON.parse(repairJson('{"a": 1, "b": 2,}'))).toEqual({ a: 1, b: 2 })
  })

  it('quotes bare keys', () => {
    expect(JSON.parse(repairJson('{score: 80, ok: true}'))).toEqual({ score: 80, ok: true })
  })

  it('replaces smart quotes', () => {
    expect(JSON.parse(repairJson('{“a”: “b”}'))).toEqual({ a: 'b' })
  })

  it('escapes literal newlines inside strings', () => {
    expect(JSON.parse(repairJson('{"body": "line one\nline two"}'))).toEqual({ body: 'line one\nline two' })
  })

  it('converts Python literals', () => {
    expect(JSON.parse(repairJson('{"a": None, "b": True}'))).toEqual({ a: null, b: true })
  })
})

describe('parseLoose', () => {
  it('parses a clean reply', () => {
    expect(parseLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('repairs a malformed reply rather than failing', () => {
    expect(parseLoose('```json\n{a: 1, b: 2,}\n```')).toEqual({ a: 1, b: 2 })
  })

  it('throws with the raw text attached when unsalvageable', () => {
    try {
      parseLoose('no json here at all')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredParseError)
      expect((e as StructuredParseError).raw).toBe('no json here at all')
    }
  })
})

describe('parseStructured', () => {
  const schema = z.object({ score: z.number(), reasons: z.array(z.string()).default([]) })

  it('applies schema defaults', () => {
    expect(parseStructured('```json\n{"score": 70}\n```', schema)).toEqual({ score: 70, reasons: [] })
  })

  it('reports which field failed validation', () => {
    expect(() => parseStructured('{"score": "high"}', schema)).toThrow(/score/)
  })
})
