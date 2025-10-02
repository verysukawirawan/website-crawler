#!/bin/bash

# Run your pnpm command and capture its output
# Make sure you are in the correct directory where 'pnpm run start' can be executed
echo "Running pnpm run start..."
crawl_output=$(pnpm run start)


# Use grep with extended regex (-E) to look for either pattern in the captured output
# -q (quiet) suppresses output, -E enables extended regex
if echo "$crawl_output" | grep -Eq "Status (404|301) \([0-9]+ internal URLs\):"; then
  curl -X POST "https://api.cloudflare.com/client/v4/zones/0ee220fbd6e2c394e9e47330c07aa86d/purge_cache" \
     -H "X-Auth-Email: thomas@cosmo.com.sg" \
     -H "Authorization: Bearer A5P9eyfOlzXMvPzg0LNF7ZFUl6-Xz9CimBi0qVuq" \
     -H "Content-Type: application/json" \
     --data '{"hosts":["gili-lankanfushi.com"]}'
else
  echo "No Status 300 or 400 internal URLs found."
fi