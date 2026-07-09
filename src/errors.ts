/** Renders any thrown value as a display string, for user-facing Notices and error messages. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
