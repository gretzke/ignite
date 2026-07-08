# ignite-infura-plugin

A third-party [Ignite](https://github.com/gretzke/ignite) RPC-provider plugin
for [Infura](https://www.infura.io/).

The plugin turns a single Infura project API key into ready-to-use RPC
endpoints for every chain Infura supports. It has no other side effects: no
filesystem writes, no outbound network calls of its own — it just maps the
key onto Infura's `https://<network>.infura.io/v3/<key>` URL scheme.

## Configuration

| Field | Key | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| API Key | `api-key` | string | yes | Secret — stored in Ignite's encrypted vault, never written to disk by this plugin. |

Once the API key is configured and the plugin is granted access to the
secret, endpoints appear for:

Mainnet, Sepolia, Holesky, Optimism (+ Sepolia), Arbitrum (+ Sepolia),
Polygon (+ Amoy), Base (+ Sepolia), Linea, Avalanche, BSC, Scroll.

## Installing into Ignite

- **Local path (dev mode):** run Ignite with `--dev`, then Settings →
  Plugins → `+` → *From Local Path* and select this directory.
- **Git URL (after spin-out):** Settings → Plugins → `+` → *From GitHub*
  once this plugin lives in its own repository.

After installing, configure the API key from the plugin's config form and
grant the secret scope when prompted. The resulting endpoints show up per
chain in Settings → Chains → the RPC modal for any chain Infura supports.

## Protocol

Ignite execs `node /plugin/index.js <operation>` inside the container,
writes an options JSON object to stdin, and parses the response from stdout
framed by sentinels (framing is mandatory):

```
<<<IGNITE_RESULT_BEGIN>>>{ "success": true, "data": ... }<<<IGNITE_RESULT_END>>>
```

Implemented operations:

- `getInfo` — plugin metadata (`id: infura`, `type: rpc-provider`,
  `configFields` declaring the secret `api-key` field)
- `getSupportedChains` — reads `options.config['api-key']`; with no key
  configured, returns `{ chains: [] }`. With a key, returns
  `{ chains: [{ chainId, url, label }] }` for every supported network.

## Permissions

None — this plugin declares no permission requests. It reads the API key
Ignite injects via `options.config` and does not touch the workspace,
filesystem, or network.
