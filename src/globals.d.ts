/** Ambient declarations for platform APIs TypeScript's lib does not ship yet. */

/**
 * The Navigation API. Available in Chromium 102+, still absent from lib.dom.
 * Only the event-target surface is declared because that is all we use: a
 * `navigate` listener as a supplement to YouTube's own navigation events.
 */
interface Window {
  readonly navigation?: EventTarget;
}
