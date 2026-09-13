/**
 * Search recipes.
 *
 * Recipes save immediately rather than joining the page's draft, because they
 * are separate records with their own lifecycle and because "run this one now"
 * needs the stored version, not the draft.
 */

import { useState } from 'react'
import { api, useAction, useAsync } from '../../shared/api'
import { Badge, Empty, Field, ListInput, NumberInput, Section, Select, Spinner, TextInput, Toggle } from '../../shared/components'
import { formatRelative, uid } from '@/shared/util'
import type { SearchRecipe } from '@/storage/schemas'

const SOURCE_HELP: Record<SearchRecipe['source'], string> = {
  greenhouse: 'Reads company boards through Greenhouse’s public JSON. Add company slugs, e.g. "stripe".',
  lever: 'Reads company boards through Lever’s public JSON. Add company slugs, e.g. "ramp".',
  ashby: 'Reads company boards through Ashby’s public JSON. Add board names as they appear in the URL.',
  indeed: 'Opens Indeed searches in a background tab. Slower, and Indeed actively discourages automation.',
  naukri: 'Opens Naukri searches in a background tab. Good coverage for India.',
  custom: 'Paste full search URLs. Scraped with the generic listing reader.',
}

export default function SearchesSection() {
  const { data: recipes, loading, reload } = useAsync(() => api.getRecipes(), [])
  const { run, busy, error } = useAction()
  const [setupSummary, setSetupSummary] = useState<string[] | null>(null)

  /**
   * Build real searches from the profile.
   *
   * The alternative was shipping example searches aimed at companies the user
   * has never mentioned, which they then had to understand, edit and switch on
   * before anything worked at all. Asking the model once is faster and produces
   * something aimed at them.
   */
  const setupFromProfile = () =>
    run(async () => {
      setSetupSummary(null)
      const [suggestion, profile] = await Promise.all([api.suggestRules(), api.getProfile()])
      const keywords = suggestion.searchKeywords.length > 0 ? suggestion.searchKeywords : suggestion.titleIncludes
      const created: string[] = []

      const make = async (recipe: SearchRecipe, description: string) => {
        await api.saveRecipe(recipe)
        created.push(description)
      }

      if (suggestion.greenhouseBoards.length > 0) {
        await make(
          {
            id: uid('recipe'),
            name: 'Greenhouse boards',
            enabled: true,
            source: 'greenhouse',
            keywords,
            location: '',
            remoteOnly: false,
            boards: suggestion.greenhouseBoards,
            customUrls: [],
            maxResultsPerRun: 40,
            lastRunAt: null,
          },
          `Greenhouse: ${suggestion.greenhouseBoards.join(', ')}`
        )
      }

      if (suggestion.leverBoards.length > 0) {
        await make(
          {
            id: uid('recipe'),
            name: 'Lever boards',
            enabled: true,
            source: 'lever',
            keywords,
            location: '',
            remoteOnly: false,
            boards: suggestion.leverBoards,
            customUrls: [],
            maxResultsPerRun: 40,
            lastRunAt: null,
          },
          `Lever: ${suggestion.leverBoards.join(', ')}`
        )
      }

      // Naukri is the only broad search switched on automatically, and only for
      // India. Indeed stays off deliberately: its terms prohibit automation.
      if (/india/i.test(profile.country) && keywords.length > 0) {
        await make(
          {
            id: uid('recipe'),
            name: `Naukri - ${keywords[0]}`,
            enabled: true,
            source: 'naukri',
            keywords,
            location: profile.city,
            remoteOnly: false,
            boards: [],
            customUrls: [],
            maxResultsPerRun: 30,
            lastRunAt: null,
          },
          `Naukri: ${keywords.join(', ')}${profile.city ? ` in ${profile.city}` : ''}`
        )
      }

      if (created.length === 0) {
        created.push(
          'Nothing could be built automatically - the model did not return board names it was confident about. Add one by hand below.'
        )
      }

      setSetupSummary(created)
      reload()
    }, 'setting up')

  const add = () => {
    const recipe: SearchRecipe = {
      id: uid('recipe'),
      name: 'New search',
      enabled: false,
      source: 'greenhouse',
      keywords: [],
      location: '',
      remoteOnly: false,
      boards: [],
      customUrls: [],
      maxResultsPerRun: 40,
      lastRunAt: null,
    }
    void run(async () => { await api.saveRecipe(recipe); reload() }, 'adding')
  }

  if (loading && !recipes) return <Spinner label="Loading searches" />

  const enabledCount = (recipes ?? []).filter((r) => r.enabled).length

  return (
    <div>
      <Section
        title="Set up searches from my profile"
        description="Reads what you have done and creates real, switched-on searches aimed at it. You can edit or delete them afterwards."
        actions={
          <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={setupFromProfile}>
            {busy === 'setting up' ? 'Working…' : 'Set them up for me'}
          </button>
        }
      >
        {enabledCount === 0 && (
          <p className="surface-quiet px-3 py-2.5 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
            No searches are switched on, so the agent has nowhere to look and will refuse to start. This is the
            quickest way out of that.
          </p>
        )}

        {setupSummary && (
          <div className="rounded-md px-3 py-2.5" style={{ background: 'var(--good-soft)' }}>
            <p className="text-[12.5px] font-medium" style={{ color: 'var(--good)' }}>
              Created and switched on:
            </p>
            <ul className="mt-1 list-inside list-disc text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
              {setupSummary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
              Board names are the model's best guess. Press <em>Run</em> on one — if it returns nothing, the slug is
              wrong, and the right one is in that company's careers URL.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Where to look"
        description="Each recipe is one source and one set of filters. Disabled recipes are ignored by scheduled runs but can still be run by hand."
        actions={
          <>
            <button className="btn btn-sm" disabled={!!busy} onClick={add}>
              Add search
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!!busy}
              onClick={() => run(async () => { await api.runDiscovery(); reload() }, 'running')}
            >
              {busy === 'running' ? 'Searching…' : 'Run all enabled'}
            </button>
          </>
        }
      >
        {error && (
          <p className="mb-2 text-[12px]" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}

        {recipes?.length === 0 && <Empty title="No searches yet" hint="Add one to tell the agent where to look." />}

        <div className="flex flex-col gap-3">
          {recipes?.map((recipe) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              busy={!!busy}
              onSave={(next) => run(async () => { await api.saveRecipe(next); reload() }, 'saving')}
              onDelete={() => run(async () => { await api.deleteRecipe(recipe.id); reload() }, 'deleting')}
              onRun={() => run(async () => { await api.runDiscovery(recipe.id); reload() }, 'running')}
            />
          ))}
        </div>
      </Section>
    </div>
  )
}

function RecipeCard({
  recipe,
  busy,
  onSave,
  onDelete,
  onRun,
}: {
  recipe: SearchRecipe
  busy: boolean
  onSave: (r: SearchRecipe) => void
  onDelete: () => void
  onRun: () => void
}) {
  const [draft, setDraft] = useState(recipe)
  const [open, setOpen] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(recipe)
  const patch = (p: Partial<SearchRecipe>) => setDraft((d) => ({ ...d, ...p }))

  return (
    <div className="surface px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{draft.name}</span>
            <Badge tone={draft.enabled ? 'good' : 'neutral'}>{draft.enabled ? 'on' : 'off'}</Badge>
            <Badge>{draft.source}</Badge>
          </div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            {draft.keywords.join(', ') || 'no keywords'}
            {draft.location ? ` · ${draft.location}` : ''} · last run {formatRelative(recipe.lastRunAt)}
          </div>
        </button>
        <div className="flex shrink-0 gap-1.5">
          <button className="btn btn-sm" disabled={busy} onClick={onRun}>
            Run
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
            </Field>
            <Field label="Source">
              <Select
                value={draft.source}
                onChange={(v) => patch({ source: v })}
                options={[
                  { value: 'greenhouse', label: 'Greenhouse boards' },
                  { value: 'lever', label: 'Lever boards' },
                  { value: 'ashby', label: 'Ashby boards' },
                  { value: 'naukri', label: 'Naukri search' },
                  { value: 'indeed', label: 'Indeed search' },
                  { value: 'custom', label: 'Custom URLs' },
                ]}
              />
            </Field>
          </div>

          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            {SOURCE_HELP[draft.source]}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3">
            {(draft.source === 'greenhouse' || draft.source === 'lever' || draft.source === 'ashby') && (
              <Field label="Company boards" wide hint="One slug per line, taken from the board URL.">
                <ListInput value={draft.boards} onChange={(v) => patch({ boards: v })} rows={4} placeholder={'stripe\nfigma'} />
              </Field>
            )}

            {(draft.source === 'custom' || draft.source === 'indeed' || draft.source === 'naukri') && (
              <Field label="Custom URLs" wide hint="Leave empty to build a search from the keywords and location below.">
                <ListInput value={draft.customUrls} onChange={(v) => patch({ customUrls: v })} rows={3} />
              </Field>
            )}

            <Field label="Keywords" hint="Titles must contain at least one of these.">
              <ListInput value={draft.keywords} onChange={(v) => patch({ keywords: v })} rows={3} />
            </Field>
            <Field label="Location">
              <TextInput value={draft.location} onChange={(v) => patch({ location: v })} placeholder="Bengaluru" />
            </Field>
            <Field label="Max results per run">
              <NumberInput value={draft.maxResultsPerRun} onChange={(v) => patch({ maxResultsPerRun: v })} min={1} max={200} />
            </Field>
          </div>

          <div className="mt-1">
            <Toggle checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label="Include in scheduled runs" />
            <Toggle checked={draft.remoteOnly} onChange={(v) => patch({ remoteOnly: v })} label="Remote roles only" />
          </div>

          <div className="mt-3 flex gap-1.5">
            <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={() => onSave(draft)}>
              {dirty ? 'Save search' : 'Saved'}
            </button>
            <button className="btn btn-danger btn-sm ml-auto" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
