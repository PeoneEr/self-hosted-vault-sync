import { requestUrl } from 'obsidian';

/**
 * Thrown by PairingClient when the server responds with a non-2xx status.
 * Carries the status code (not just baked into the message string) so
 * callers can distinguish "unreachable"/"bad token"/"server error" without
 * parsing message text — see OnboardingModal's connection-check flow.
 */
export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface PairedDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PairResult {
  id: string;
  token: string;
}

export class PairingClient {
  constructor(private serverUrl: string, private authToken: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    };
  }

  async pair(label: string): Promise<PairResult> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/pair`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ label }),
      throw: false,
    });
    if (resp.status >= 400) throw new HttpError(`pair failed: ${resp.status}`, resp.status);
    // requestUrl types `.json` as `any`; assert the shape the server contract
    // guarantees rather than letting `any` propagate to callers.
    return resp.json as PairResult;
  }

  async listDevices(): Promise<PairedDevice[]> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/devices`,
      headers: this.headers(),
      throw: false,
    });
    if (resp.status >= 400) throw new HttpError(`listDevices failed: ${resp.status}`, resp.status);
    return resp.json as PairedDevice[];
  }

  async revokeDevice(id: string): Promise<void> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/devices/${encodeURIComponent(id)}`,
      method: 'DELETE',
      headers: this.headers(),
      throw: false,
    });
    if (resp.status >= 400) throw new HttpError(`revokeDevice failed: ${resp.status}`, resp.status);
  }
}

/** The action segment of the obsidian:// pairing URI, e.g. obsidian://self-hosted-vault-sync?... */
export const PAIRING_PROTOCOL_ACTION = 'self-hosted-vault-sync';

export function buildPairingUri(serverUrl: string, token: string, label: string): string {
  const params = new URLSearchParams({ server: serverUrl, token, label });
  return `obsidian://${PAIRING_PROTOCOL_ACTION}?${params.toString()}`;
}

export interface PairingParams {
  server: string;
  token: string;
  label?: string;
}

/**
 * Parses the query params Obsidian hands to a registerObsidianProtocolHandler
 * callback. Returns null if the link is missing server or token — a
 * malformed/foreign link should be rejected rather than silently accepted.
 */
export function parsePairingParams(params: Record<string, string>): PairingParams | null {
  if (!params.server || !params.token) return null;
  return { server: params.server, token: params.token, label: params.label };
}

/**
 * Parses a manually pasted obsidian:// pairing link (as an alternative to
 * the OS recognizing and opening it as a clickable link). Reuses
 * parsePairingParams for the same server/token validation the
 * protocol-handler path uses, so a malformed or foreign link is rejected
 * the same way in both places.
 */
export function parsePastedPairingLink(text: string): PairingParams | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { params[key] = value; });
  return parsePairingParams(params);
}
