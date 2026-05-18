# n8n-nodes-gmaps-paginator

n8n community node to paginate Google Maps search results through a configurable HTTP proxy (Evomi residential by default).

## What it does

Takes a Google Maps prefetch URL (extracted upstream) and loops through paginated result pages, parsing each into structured place records (fid, name, address, phone, rating, categories, place_id, etc.).

## Key design decisions

- **Per-call state isolation**: every invocation creates fresh `http.Agent` and `https.Agent` instances with `keepAlive: false`. This is critical when n8n fires multiple parallel sub-workflow executions — no TCP socket reuse, no correlated traffic.
- **Per-call session generation**: a fresh Evomi session ID is generated inside the per-item loop, never at module scope.
- **Honest errors**: real axios error messages (ECONNREFUSED, timeouts, auth failures) are surfaced in `stop_reason`. Generic `cap_hit` only fires when response size is genuinely below threshold.
- **Configurable proxy**: pass proxy host/port/user/pass/country either inline or via stored Evomi credential.

## Local Development

```bash
# clone your fork
git clone https://github.com/YOUR_GITHUB_USERNAME/n8n-nodes-gmaps-paginator.git
cd n8n-nodes-gmaps-paginator

# install deps
npm install

# build
npm run build

# watch mode for development
npm run dev
```

## Publishing to npm

```bash
# one-time
npm login

# bump version in package.json then
npm publish --access public
```

## Installing in n8n

Once published to npm:

1. Open n8n
2. Settings → Community Nodes → Install
3. Enter: `n8n-nodes-gmaps-paginator`
4. Click Install
5. Restart n8n if prompted

The node appears in the editor palette as **Google Maps Paginator**.

## Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | string | yes | Prefetch URL extracted from Google Maps HTML shell |
| `maxResults` | number | no (default 240) | Max places to collect |
| `snapshotId` | string | no | Passthrough job identifier |
| `cell` | string | no | Passthrough grid cell |
| `lat`, `lng` | string | no | Passthrough coords |
| `proxySource` | enum | yes | `manual` or `credential` |
| `proxyHost/Port/Username/Password/Country` | various | when manual | Proxy details |

## Output

```json
{
  "snapshot_id": "...",
  "cell": "...",
  "lat": "...",
  "lng": "...",
  "ok": true,
  "places_count": 200,
  "places": [
    {
      "fid": "0x3bcb...",
      "name": "Lake View Cafe",
      "full_address": "...",
      "phone": "+91 86574 15264",
      "rating": 4.7,
      "review_count": 2299,
      "categories": ["Restaurant", "Chinese restaurant"],
      "website": "http://lakeviewcafepowai.com/",
      "place_id_cid": "ChIJV...",
      "raw_record": [null, null, ... full Google container array ...]
    }
  ],
  "stats": {
    "raw_count": 200,
    "last_offset": 200,
    "stop_reason": "max_results_reached",
    "seconds": 18.4,
    "proxy_session": "lqz4m1p8d3xa92",
    "pages_fetched": 10
  }
}
```

> Note: `raw_record` is only present when the **Include Raw Record** advanced option is enabled. It contains the full Google container array for that place, useful for extracting fields not parsed by default (opening hours, photos, additional metadata, etc.) in your downstream workflow.

## Stop reasons

| Reason | Meaning |
|---|---|
| `max_results_reached` | Got enough places, stopped cleanly |
| `pagination_param_not_found` | baseUrl missing pagination token (bad upstream URL) |
| `cap_hit (response_size=N, http=200)` | Google returned small response, likely soft-blocked |
| `fetch_error: ECONNRESET ...` | Network/proxy error, real message included |
| `empty_parse` | Response parsed to zero containers |
| `all_duplicates` | New page returned only already-seen places |
| `loop_end` | Reached MAX_OFFSET cap |

## License

MIT
