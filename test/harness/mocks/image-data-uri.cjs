// dead-* URLs always 404. rl-* URLs return HTTP 429 for the first N calls per URL
// (N = global.RL_FAILS_PER_URL, default 1; Infinity = always), then succeed.
const calls = new Map();
module.exports = {
  encodeFromURL: async (u) => {
    if (u.includes('dead')) throw new Error(`ImageDataURI :: Error :: GET -> ${u} returned an HTTP 404 status!`);
    if (u.includes('rl-')) {
      const n = (calls.get(u) || 0) + 1; calls.set(u, n);
      const limit = global.RL_FAILS_PER_URL == null ? 1 : global.RL_FAILS_PER_URL;
      if (n <= limit) throw `ImageDataURI :: Error :: GET -> ${u} returned an HTTP 429 status!`; // the real library throws strings
    }
    return 'data:';
  },
  decode: async () => ({ dataBuffer: Buffer.from('x') })
};
