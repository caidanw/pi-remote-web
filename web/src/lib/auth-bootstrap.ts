export async function runAuthenticatedStartup(
  authenticate: () => Promise<boolean>,
  loadProtectedUi: () => Promise<void>,
): Promise<boolean> {
  const authenticated = await authenticate();
  if (authenticated) await loadProtectedUi();
  return authenticated;
}
