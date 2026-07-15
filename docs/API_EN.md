# Plugin Configuration API

Replace `https://config.example.com` with the installed console domain.

## UUID Check

```http
GET https://config.example.com/admin-api/plugin-public/active-meta.json
```

This public endpoint requires no login and returns only:

```json
{
  "uuid": "a9dc477f-4cd1-48ac-8662-38f42b15bbcb",
  "updated_at": "2026-07-15T03:00:00.000Z"
}
```

## Full Active Configuration

```http
GET https://config.example.com/admin-api/plugin-public/active.json
```

```json
{
  "uuid": "a9dc477f-4cd1-48ac-8662-38f42b15bbcb",
  "updated_at": "2026-07-15T03:00:00.000Z",
  "enabled": true,
  "data": [
    {
      "Group": "live",
      "LP": 1000,
      "TP": 10
    }
  ]
}
```

The administration page provides parameter rows for `Group`, `LP`, and `TP`. Raw JSON mode remains available for an existing configuration whose `data` is not an array; opening or upgrading such a file does not convert it.

Every successful administrator save creates a new UUID. Installing or upgrading the console does not change existing configuration files or UUIDs.

Each saved file also has a public no-login URL:

```http
GET https://config.example.com/admin-api/plugin-public/plugin_config.json
```

## Plugin Feedback

```http
GET https://config.example.com/admin-api/plugin-feedback
```

Only these query parameters are accepted:

| Parameter | Required | Description |
| --- | --- | --- |
| `uuid` | Yes | UUID currently checked or loaded by the plugin |
| `status` | Yes | `read`, `connected`, `unchanged`, `error`, or `failed` |
| `plugin_version` | Recommended | Plugin version, for example `1.2.0` |

No other feedback parameters are supported.

Full read completed:

```text
https://config.example.com/admin-api/plugin-feedback?uuid=a9dc477f-4cd1-48ac-8662-38f42b15bbcb&status=read&plugin_version=1.2.0
```

UUID unchanged and connection healthy:

```text
https://config.example.com/admin-api/plugin-feedback?uuid=a9dc477f-4cd1-48ac-8662-38f42b15bbcb&status=unchanged&plugin_version=1.2.0
```

Configuration load failed:

```text
https://config.example.com/admin-api/plugin-feedback?uuid=a9dc477f-4cd1-48ac-8662-38f42b15bbcb&status=error&plugin_version=1.2.0
```

Success response:

```json
{
  "ok": true,
  "id": "feedback-record-uuid",
  "received_at": "2026-07-15T03:05:00.000Z"
}
```

## Plugin Flow

1. Poll `active-meta.json`.
2. If the UUID differs from the last successfully loaded UUID, download `active.json`.
3. Validate and fully apply the configuration.
4. Store the UUID locally only after the complete configuration is applied successfully, then report `status=read`.
5. If the UUID is unchanged, only check the connection and report `status=unchanged` or `status=connected`.
6. Send a healthy report about every five minutes. The console marks a connection stale after ten minutes.

Support: [support@forbrokers.com](mailto:support@forbrokers.com)

Developer: [forbrokers.com](https://forbrokers.com)
