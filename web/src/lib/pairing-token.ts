const PAIRING_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function pairingTokenFromQr(value: string, currentOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== currentOrigin) return null;
  const token = new URLSearchParams(url.hash.slice(1)).get("pair");
  return token && PAIRING_TOKEN.test(token) ? token : null;
}
