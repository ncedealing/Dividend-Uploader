# 插件配置 API 中文说明

请将 `https://config.example.com` 替换为实际安装域名。

## UUID 检查

```http
GET https://config.example.com/admin-api/plugin-public/active-meta.json
```

此接口公开访问，无需登录，并且只返回：

```json
{
  "uuid": "a9dc477f-4cd1-48ac-8662-38f42b15bbcb",
  "updated_at": "2026-07-15T03:00:00.000Z"
}
```

## 完整活动配置

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

后台页面提供 `Group`、`LP`、`TP` 参数配置行。若已有配置的 `data` 不是数组，页面会保留原始 JSON 模式；打开文件或升级程序都不会自动转换已有数据。

管理员每次成功保存配置都会生成新 UUID。安装或升级控制台不会修改已有配置文件和 UUID。

每个已保存文件也有一个无需登录的公开地址：

```http
GET https://config.example.com/admin-api/plugin-public/plugin_config.json
```

## 插件回传

```http
GET https://config.example.com/admin-api/plugin-feedback
```

只接受以下三个查询参数：

| 参数 | 要求 | 说明 |
| --- | --- | --- |
| `uuid` | 必传 | 插件当前检查或已经加载的配置 UUID |
| `status` | 必传 | `read`、`connected`、`unchanged`、`error` 或 `failed` |
| `plugin_version` | 建议 | 插件版本，例如 `1.2.0` |

不再接受 `filename`、`mode`、`message`、`server`、`account` 或其他回传参数。

完整读取成功：

```text
https://config.example.com/admin-api/plugin-feedback?uuid=a9dc477f-4cd1-48ac-8662-38f42b15bbcb&status=read&plugin_version=1.2.0
```

UUID 未变化且连接正常：

```text
https://config.example.com/admin-api/plugin-feedback?uuid=a9dc477f-4cd1-48ac-8662-38f42b15bbcb&status=unchanged&plugin_version=1.2.0
```

配置读取失败：

```text
https://config.example.com/admin-api/plugin-feedback?uuid=a9dc477f-4cd1-48ac-8662-38f42b15bbcb&status=error&plugin_version=1.2.0
```

成功响应：

```json
{
  "ok": true,
  "id": "feedback-record-uuid",
  "received_at": "2026-07-15T03:05:00.000Z"
}
```

## 插件处理流程

1. 定时请求 `active-meta.json`。
2. 如果 UUID 与插件本地最后成功加载的 UUID 不同，请求完整 `active.json`。
3. 校验并完整应用配置。
4. 只有完整应用成功后，才在插件本地保存该 UUID，并回传 `status=read`。
5. UUID 没变化时只检查连接，回传 `status=unchanged` 或 `status=connected`。
6. 建议每五分钟回传一次正常状态；超过十分钟没有正常回传，后台显示连接超时。

联系邮箱：[support@forbrokers.com](mailto:support@forbrokers.com)

开发者：[forbrokers.com](https://forbrokers.com)
