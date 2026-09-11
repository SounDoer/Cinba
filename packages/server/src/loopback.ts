// Is a connection from this machine?
//
// The one question standing between a visitor and this machine's API keys. It
// answers nothing today — the service binds to 127.0.0.1, so every connection
// is local and this rejects none of them. That is the point: the check is
// already here for the day a door opens outward, rather than being something
// to remember at the moment it starts mattering.
//
// Its own module because it is worth testing, and because the address forms
// are easy to get subtly wrong.

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
