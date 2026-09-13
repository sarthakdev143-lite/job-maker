/**
 * Shared UI primitives.
 *
 * Small and unopinionated on purpose: the styling lives in styles.css as
 * component classes, so these are mostly about giving each surface the same
 * markup and the same keyboard and empty-state behaviour.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mb-6">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 max-w-2xl text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
}) {
  return (
    <input
      className="input"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <input
      className="input"
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function TextArea({
  value,
  onChange,
  rows = 5,
  placeholder,
  mono = true,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  mono?: boolean
}) {
  return (
    <textarea
      className="textarea"
      style={mono ? undefined : { fontFamily: 'inherit', fontSize: 12.5 }}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full transition-colors"
        style={{
          background: checked ? 'var(--accent)' : 'var(--line-strong)',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all"
          style={{ left: checked ? 16 : 2, boxShadow: '0 1px 2px rgba(0,0,0,.25)' }}
        />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-[12.5px] font-medium">
          {label}
        </label>
        {description && (
          <p className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            {description}
          </p>
        )}
      </div>
    </div>
  )
}

/** Comma-or-newline separated list, edited as text but stored as an array. */
export function ListInput({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  rows?: number
}) {
  const [text, setText] = useState(value.join('\n'))
  const lastExternal = useRef(value.join('\n'))

  // Adopt external changes (a reload, an import) without clobbering typing.
  useEffect(() => {
    const joined = value.join('\n')
    if (joined !== lastExternal.current) {
      lastExternal.current = joined
      setText(joined)
    }
  }, [value])

  return (
    <textarea
      className="textarea"
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        const parsed = e.target.value
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
        lastExternal.current = parsed.join('\n')
        onChange(parsed)
      }}
    />
  )
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; badge?: number }>
  active: T
  onChange: (id: T) => void
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto" style={{ borderBottom: '1px solid var(--line)' }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab ${active === t.id ? 'tab-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && (
            <span className="ml-1.5 chip chip-accent px-1.5 py-0">{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; children: ReactNode }) {
  const cls =
    tone === 'good' ? 'chip-good' : tone === 'warn' ? 'chip-warn' : tone === 'bad' ? 'chip-bad' : tone === 'accent' ? 'chip-accent' : ''
  return <span className={`chip ${cls}`}>{children}</span>
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="surface-quiet flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      {hint && (
        <p className="max-w-sm text-[12px]" style={{ color: 'var(--ink-faint)' }}>
          {hint}
        </p>
      )}
      {action}
    </div>
  )
}

export function ErrorBar({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null
  return (
    <div
      className="mb-3 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-[12px]"
      style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
    >
      <span className="min-w-0 break-words">{message}</span>
      {onDismiss && (
        <button className="btn btn-ghost btn-sm" style={{ color: 'inherit' }} onClick={onDismiss}>
          dismiss
        </button>
      )}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
      <span
        className="inline-block h-3 w-3 animate-spin rounded-full"
        style={{ border: '2px solid var(--line-strong)', borderTopColor: 'var(--accent)' }}
      />
      {label ?? 'Loading'}
    </div>
  )
}

export function ProgressBar({ active }: { active: boolean }) {
  return (
    <div
      className={`h-[3px] w-full overflow-hidden rounded-full ${active ? 'progress-indeterminate' : ''}`}
      style={{ background: active ? 'var(--bg-soft)' : 'transparent' }}
    />
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--ink)'
  return (
    <div className="surface px-3 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </div>
      <div className="mt-0.5 text-[17px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  )
}

/** Two-click confirmation, so a destructive action needs intent but no modal. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Really?',
  className = 'btn btn-danger btn-sm',
}: {
  onConfirm: () => void
  children: ReactNode
  confirmLabel?: string
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3500)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <button
      className={className}
      onClick={() => {
        if (armed) {
          onConfirm()
          setArmed(false)
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}

export function scoreTone(score: number | null | undefined): 'good' | 'warn' | 'bad' | 'neutral' {
  if (score === null || score === undefined) return 'neutral'
  if (score >= 80) return 'good'
  if (score >= 65) return 'warn'
  return 'bad'
}

export function statusTone(status: string): 'good' | 'warn' | 'bad' | 'accent' | 'neutral' {
  switch (status) {
    case 'submitted':
    case 'applied':
      return 'good'
    case 'needs_review':
    case 'dry_run':
    case 'queued':
      return 'warn'
    case 'failed':
    case 'rejected':
      return 'bad'
    case 'running':
      return 'accent'
    default:
      return 'neutral'
  }
}
