import os from 'node:os';
import type { IncomingMessage } from 'node:http';

/**
 * This machine's addresses on the local network, as origins phones can open ("https://192.168.1.35:5173").
 * Used when HQ runs the app on the PC at localhost: links and QR codes made there must not say
 * "localhost". Private ranges first (home/office Wi-Fi), VPN-style and link-local addresses left out.
 */
export function lanOrigins(protocol: 'http' | 'https', port: number, interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const ips = Object.values(interfaces)
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address)
    .filter((ip) => rank(ip) < 3)
    .sort((a, b) => rank(a) - rank(b));
  const shown = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80) ? '' : `:${port}`;
  return [...new Set(ips)].map((ip) => `${protocol}://${ip}${shown}`);
}

/** Whether the server that took this request listens on every interface (0.0.0.0 / ::), not just localhost. */
export function listensOnAll(req: IncomingMessage) {
  try {
    const server = (req.socket as unknown as { server?: { address(): unknown } }).server;
    const a = server?.address() as { address?: string } | null | undefined;
    return !!a && (a.address === '::' || a.address === '0.0.0.0');
  } catch {
    return false;
  }
}
