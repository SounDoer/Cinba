// Recognize an IP address belonging to this machine's loopback interface.
// Kept separate because the address forms are easy to get subtly wrong.

/**
 * Node reports an IPv4 client on a dual-stack socket as an IPv4-mapped IPv6
 * address, so "::ffff:127.0.0.1" and "127.0.0.1" are the same caller and both
 * have to pass. Everything unrecognised fails closed, including undefined,
 * which is what a socket reports once it has gone away.
 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (plain === "::1") {
    return true;
  }

  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  const parts = plain.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256);
}
