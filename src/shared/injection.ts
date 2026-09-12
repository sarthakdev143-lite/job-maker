/**
 * Resolving content script paths at runtime.
 *
 * The bundler emits hashed filenames, and they change on every build, so
 * nothing may hard-code a path to an injected script. Reading them back out of
 * the live manifest is the only version that keeps working -- in the dev server
 * and in a packed release alike.
 *
 * Injection is needed in two situations the declared content scripts do not
 * cover: a tab that was already open when the extension was installed or
 * reloaded, and a domain the user added by hand.
 */

const DEEPSEEK_HINT = 'deepseek'

function manifestScripts(): chrome.runtime.ManifestV3['content_scripts'] {
  return chrome.runtime.getManifest().content_scripts ?? []
}

/** Built file paths for the DeepSeek bridge. */
export function deepseekBridgeFiles(): string[] {
  const entry = manifestScripts()?.find((s) => s.matches?.some((m) => m.includes(DEEPSEEK_HINT)))
  return entry?.js ?? []
}

/** Built file paths for the form agent. */
export function formAgentFiles(): string[] {
  const entry = manifestScripts()?.find((s) => !s.matches?.some((m) => m.includes(DEEPSEEK_HINT)))
  return entry?.js ?? []
}

/**
 * Inject a script into a tab, ignoring the failures that are expected rather
 * than exceptional: a page we lack host permission for, a tab that navigated
 * away mid-call, a restricted chrome:// URL.
 */
export async function injectFiles(
  tabId: number,
  files: string[],
  options: { allFrames?: boolean } = {}
): Promise<boolean> {
  if (files.length === 0) return false
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: options.allFrames ?? false },
      files,
    })
    return true
  } catch {
    return false
  }
}
