# ignite-chainz-plugin

A third-party [Ignite](https://github.com/gretzke/ignite) RPC-provider plugin
for [chainz](https://chainz.crunch.finance/).

The plugin reads a chainz configuration file containing RPC endpoints and API
keys, then exposes those endpoints as per-chain RPC options in Ignite. It has
no other side effects: no filesystem writes, no outbound network calls of its
own — it just parses and interpolates the chainz config format onto Ignite's
chains UI.

## Configuration

| Field | Key | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| chainz config | `chainz-config` | string | yes | Secret — the contents of `~/.chainz.json`, stored in Ignite's encrypted vault, never written to disk by this plugin. |

Once the config is pasted and the plugin is granted access to the secret,
endpoints appear for every chain defined in the configuration file.

## Setup

### 1. Prepare your chainz config

Copy the contents of `~/.chainz.json` to your clipboard:

```bash
pbcopy < ~/.chainz.json
```

### 2. Configure the plugin in Ignite

- Settings → Plugins → Configure `chainz`
- Paste the clipboard contents into the "chainz config" secret field
- Click Save

### 3. Grant permissions

When prompted (or via Settings → Permissions), grant the `chainz` plugin
access to the secret scope. After granting, the RPC endpoints appear in
Settings → Chains → the RPC modal for any chain in your config.

## Configuration file format

The chainz config file (`~/.chainz.json`) is expected to have this shape:

```json
{
  "chains": [
    {
      "name": "Ethereum Mainnet",
      "chain_id": 1,
      "rpc_urls": [
        "https://eth.rpc.example.com",
        "https://eth-backup.rpc.example.com"
      ],
      "selected_rpc": "https://eth-primary.rpc.example.com"
    }
  ],
  "variables": {
    "INFURA_API_KEY": "your_key_here",
    "ALCHEMY_API_KEY": "another_key"
  }
}
```

- `chains` — array of chain definitions, each with a positive integer `chain_id`,
  optional `name`, and arrays of `rpc_urls` and a `selected_rpc`.
- `variables` — object mapping variable names to values; any `${VAR_NAME}` in
  RPC URLs is interpolated against this map.
- RPC URLs with unmatched variables are skipped (not passed to Ignite).
- Only `https://` URLs are exposed (websocket and other schemes are filtered).
- The `selected_rpc` is listed first with a "(selected)" label suffix.

## Protocol

Ignite execs `node /plugin/index.js <operation>` inside the container,
writes an options JSON object to stdin, and parses the response from stdout
framed by sentinels (framing is mandatory):

```
<<<IGNITE_RESULT_BEGIN>>>{ "success": true, "data": ... }<<<IGNITE_RESULT_END>>>
```

Implemented operations:

- `getInfo` — plugin metadata (`id: chainz`, `type: rpc-provider`,
  `configFields` declaring the secret `chainz-config` field)
- `getSupportedChains` — reads `options.config['chainz-config']` as a JSON
  string; with no config or malformed JSON, returns `{ chains: [] }`. With
  a valid config, parses the chainz format and returns
  `{ chains: [{ chainId, url, label }] }` for each interpolated URL.

## Permissions

None — this plugin declares no permission requests. It reads the config
Ignite injects via `options.config` and does not touch the workspace,
filesystem, or network.

## Future: file-picker config type

Currently, the config is pasted as text into a secret field. A future Ignite
version may add a file-picker config type, which would allow selecting
`~/.chainz.json` directly without copy-pasting.
