/** The one mapshaper entry point the province pipeline uses. The package ships no types. */
declare module 'mapshaper' {
  const mapshaper: {
    /**
     * Runs mapshaper commands against in-memory inputs keyed by the filenames
     * the commands reference, resolving to every `-o` output keyed by filename.
     */
    applyCommands(commands: string, input?: Record<string, unknown>): Promise<Record<string, string | Uint8Array>>;
  };
  export default mapshaper;
}
