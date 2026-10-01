// Ed25519 SPKI public keys for Novda license verification. These are public
// verification materials, not signing material.
const NOVDA_LICENSE_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt2L3TjxO3IiAObcX7xM6H5JEJ40yVqS+7d92pPXw56k=
-----END PUBLIC KEY-----`;
const NOVDA_LEGACY_LICENSE_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0zlHlUBDPe+JSsWgR/RrOEuBndp9ozWOZdo4eVCb6o4=
-----END PUBLIC KEY-----`;

module.exports = { NOVDA_LICENSE_ED25519_PUBLIC_KEY, NOVDA_LEGACY_LICENSE_ED25519_PUBLIC_KEY };
