/**
 * Settings.
 *
 * Every knob the agent has is here, grouped by what the user is thinking about
 * rather than by which module reads it. Settings and profile are held as one
 * local draft and saved explicitly: half-typed autonomy thresholds should not
 * take effect mid-keystroke while the agent is running.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, useAsync } from '../shared/api'
import { ErrorBar, Spinner } from '../shared/components'
import ProfileSection from './sections/Profile'
import SearchesSection from './sections/Searches'
import MatchingSection from './sections/Matching'
import AutonomySection from './sections/Autonomy'
import ModelSection from './sections/Model'
import DocumentsSection from './sections/Documents'
import PromptsSection from './sections/Prompts'
import AnswersSection from './sections/Answers'
import AdvancedSection from './sections/Advanced'
import type { Profile, Settings } from '@/storage/schemas'

const NAV = [
  { id: 'profile', label: 'Profile', hint: 'Who you are' },
  { id: 'searches', label: 'Searches', hint: 'Where to look' },
  { id: 'matching', label: 'Matching', hint: 'What counts as a fit' },
  { id: 'autonomy', label: 'Autonomy', hint: 'How far it goes alone' },
  { id: 'model', label: 'Model', hint: 'The thinking engine' },
  { id: 'documents', label: 'Documents', hint: 'Resume and cover letter' },
  { id: 'prompts', label: 'Prompts', hint: 'What it is told to do' },
  { id: 'answers', label: 'Answer bank', hint: 'What it has learned' },
  { id: 'advanced', label: 'Advanced', hint: 'Domains, backup, reset' },
] as const

type NavId = (typeof NAV)[number]['id']

/** The side panel links here with a section in the hash, e.g. #searches. */
function sectionFromHash(): NavId {
  const hash = window.location.hash.replace('#', '')
  return (NAV.find((n) => n.id === hash)?.id ?? 'profile') as NavId
}

export default function App() {
  const [section, setSectionState] = useState<NavId>(sectionFromHash)

  const setSection = useCallback((next: NavId) => {
    setSectionState(next)
    window.history.replaceState(null, '', `#${next}`)
  }, [])

  useEffect(() => {
    const onHashChange = () => setSectionState(sectionFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const { data: loadedSettings, loading: loadingSettings, error: settingsError } = useAsync(() => api.getSettings(), [])
  const { data: loadedProfile, loading: loadingProfile } = useAsync(() => api.getProfile(), [])

  const [settings, setSettings] = useState<Settings | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (loadedSettings && !settings) setSettings(loadedSettings)
  }, [loadedSettings, settings])

  useEffect(() => {
    if (loadedProfile && !profile) setProfile(loadedProfile)
  }, [loadedProfile, profile])

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    setDirty(true)
  }, [])

  const patchProfile = useCallback((patch: Partial<Profile>) => {
    setProfile((p) => (p ? { ...p, ...patch } : p))
    setDirty(true)
  }, [])

  /**
   * A resume import is written by the worker before it returns, so the draft is
   * replaced wholesale and the page is not left looking unsaved.
   */
  const replaceProfile = useCallback((next: Profile) => {
    setProfile(next)
    setDirty(false)
    setSavedAt(Date.now())
  }, [])

  const save = useCallback(async () => {
    if (!settings || !profile) return
    setSaving(true)
    setSaveError('')
    try {
      await api.saveSettings(settings)
      await api.saveProfile(profile)
      setDirty(false)
      setSavedAt(Date.now())
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [settings, profile])

  // Ctrl/Cmd-S saves, because this page is long and scrolling to a button is
  // the kind of friction that makes people stop adjusting their settings.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  const current = useMemo(() => NAV.find((n) => n.id === section), [section])

  if (loadingSettings || loadingProfile || !settings || !profile) {
    return (
      <div className="p-8">
        <Spinner label="Loading settings" />
        <ErrorBar message={settingsError} />
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full max-w-[1080px] gap-6 px-6 py-6">
      <nav className="sticky top-6 h-fit w-[196px] shrink-0">
        <div className="mb-4">
          <h1 className="text-[15px] font-semibold">AutoApply</h1>
          <p className="text-[11.5px]" style={{ color: 'var(--ink-faint)' }}>
            Autonomous job applications
          </p>
        </div>

        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className="w-full rounded-md px-2.5 py-1.5 text-left transition-colors"
                style={{
                  background: section === item.id ? 'var(--accent-soft)' : 'transparent',
                  color: section === item.id ? 'var(--accent)' : 'var(--ink-soft)',
                  border: 'none',
                  cursor: 'pointer',
                }}
                onClick={() => setSection(item.id)}
              >
                <div className="text-[12.5px] font-medium">{item.label}</div>
                <div className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                  {item.hint}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-col gap-1.5">
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
          {savedAt && !dirty && (
            <p className="text-center text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              saved {new Date(savedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        <div className="mb-5">
          <h2 className="text-[18px] font-semibold">{current?.label}</h2>
          <p className="text-[12.5px]" style={{ color: 'var(--ink-faint)' }}>
            {current?.hint}
          </p>
        </div>

        <ErrorBar message={saveError} onDismiss={() => setSaveError('')} />

        {section === 'profile' && (
          <ProfileSection profile={profile} patch={patchProfile} replaceProfile={replaceProfile} />
        )}
        {section === 'searches' && <SearchesSection />}
        {section === 'matching' && <MatchingSection settings={settings} patch={patchSettings} />}
        {section === 'autonomy' && <AutonomySection settings={settings} patch={patchSettings} />}
        {section === 'model' && <ModelSection settings={settings} patch={patchSettings} />}
        {section === 'documents' && <DocumentsSection settings={settings} patch={patchSettings} />}
        {section === 'prompts' && <PromptsSection settings={settings} patch={patchSettings} />}
        {section === 'answers' && <AnswersSection />}
        {section === 'advanced' && <AdvancedSection settings={settings} patch={patchSettings} />}

        <div className="h-16" />
      </main>
    </div>
  )
}
