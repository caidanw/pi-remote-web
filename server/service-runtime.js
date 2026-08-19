export function serviceExitCode(intentionalShutdown, code, signal) {
  return intentionalShutdown ? 0 : (code ?? (signal ? 1 : 0));
}
