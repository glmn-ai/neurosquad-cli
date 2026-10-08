// Where a phone can reach this machine, and the pairing link it needs.
import { networkInterfaces } from 'node:os'

/**
 * Every IPv4 a phone on the same network could reach. Loopback is dropped (a phone cannot use it)
 * and 169.254.x.x too (APIPA: DHCP failed on that adapter). A laptop with Wi-Fi, Ethernet and a
 * VPN has several plausible answers; only the user knows which network the phone is on.
 */
export function lanAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string[] {
  const found: string[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      found.push(entry.address)
    }
  }
  return found
}

/**
 * The pairing link (what a QR code would carry): base URL plus the token in `?t=`, the form the
 * desktop's phone client reads. It IS the credential — show it only on explicit request
 * (`nsq phone pair`), never write it to a log, and rotate the token to revoke it.
 */
export function pairingUrl(
  base: string | { address: string; port: number; secure?: boolean },
  token: string
): string {
  const root =
    typeof base === 'string'
      ? base.replace(/\/+$/, '')
      : `${base.secure ? 'https' : 'http'}://${base.address}:${base.port}`
  return `${root}/?t=${encodeURIComponent(token)}`
}
