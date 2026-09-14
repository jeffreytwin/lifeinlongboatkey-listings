#!/bin/bash
# Transpile backend/sync/*.jsw and *.js into test/harness/build/*.mjs with Wix
# imports rewritten to the in-memory mocks. Functions exported from a .jsw and
# imported by another module go through a Promise-returning proxy, imitating
# Wix's cross-module web-method wrapper (see gen-proxy.mjs).
set -e
H="$(cd "$(dirname "$0")" && pwd)"
SRC="$H/../../backend"
mkdir -p "$H/build"
for f in "$SRC"/sync/*.jsw "$SRC"/sync/*.js; do
  b=$(basename "$f"); b=${b%.jsw}; b=${b%.js}
  sed -E \
    -e "s#from 'backend/sync/([a-z0-9.-]+)\.js'#from './\1.mjs'#g" \
    -e "s#from 'backend/sync/([a-z0-9.-]+)'#from './\1.proxy.mjs'#g" \
    -e "s#from 'wix-data'#from '../mocks/wix-data.mjs'#" \
    -e "s#from 'wix-fetch'#from '../mocks/wix-fetch.mjs'#" \
    -e "s#from 'wix-secrets-backend'#from '../mocks/wix-secrets-backend.mjs'#" \
    -e "s#from 'wix-media-backend'#from '../mocks/wix-media-backend.mjs'#" \
    -e "s#require\('image-data-uri'\)#(await import('../mocks/image-data-uri.cjs')).default#" \
    "$f" > "$H/build/$b.mjs"
done
JSW=$(for f in "$SRC"/sync/*.jsw; do b=$(basename "$f"); echo ${b%.jsw}; done)
node "$H/gen-proxy.mjs" "$H/build" $JSW
echo built $(ls "$H/build" | wc -l) modules
