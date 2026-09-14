/**
 * Which build this code came from.
 *
 * Chrome will happily serve a freshly rebuilt side panel while continuing to
 * run the background service worker it registered earlier, and the only visible
 * symptom is that new messages come back "unhandled" -- indistinguishable from
 * a genuine bug. Every bundle of one build carries the same stamp, so comparing
 * the panel's against the worker's turns that into a plain statement of fact.
 */

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

/** Short enough to sit in a status line without pushing anything else out. */
export function shortBuild(id: string = BUILD_ID): string {
  return id.replace(/^\d{4}-/, '').replace(/[:TZ-]/g, '').slice(0, 8)
}
