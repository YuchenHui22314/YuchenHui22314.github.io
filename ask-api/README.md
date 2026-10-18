# 提问箱 API（ask-api）

网站「提问箱」页面背后的小服务：Cloudflare Worker + D1（SQLite）数据库。免费额度对个人网站绰绰有余。

## 它怎么工作

- 访客匿名提问 → 问题**先不公开**，只有提问者本人（凭浏览器里保存的凭证）和你能看到。
- 你在 `/ask/admin/` 回复后，问题和回复一起公开。
- 提问者可以在同一个问题下继续追问；追问同样要等你回复后才公开。对话可以一直延续下去。
- 提问者的凭证只存在他自己的浏览器里（服务器只存它的哈希）。提问后页面会给出一个「专属链接」，在别的设备打开也能继续对话。
- 不存访客 IP，只存加盐哈希，用来限流（默认每个网络每小时最多 5 个新问题、20 条消息）。
- 你可以隐藏问题、关闭追问、编辑自己的回复、删除消息或整个问题。

## 本地开发

```bash
cd ask-api
npm install
cp .dev.vars.example .dev.vars   # 然后把里面的 ADMIN_TOKEN 改成一个长随机串
npm run dev                      # http://127.0.0.1:8787
npm test                         # 端到端测试（会自己起一个临时数据库）
```

在仓库根目录运行 `hugo server` 时，`config/development/params.toml` 会让提问箱页面连到本地的 8787 端口。

## 上线步骤（需要你自己操作一次）

1. 注册一个免费的 [Cloudflare](https://dash.cloudflare.com/sign-up) 账号。
2. 登录并创建数据库：
   ```bash
   cd ask-api
   npx wrangler login
   npx wrangler d1 create askbox
   ```
   把输出里的 `database_id` 填进 `wrangler.toml`。
3. 建表：`npm run migrate:remote`
4. 设置密钥（会提示你输入值，不会写进代码）：
   ```bash
   npx wrangler secret put ADMIN_TOKEN   # 管理页登录用，生成一个长随机串
   npx wrangler secret put IP_SALT       # 任意随机串
   ```
5. 部署：`npm run deploy`，会得到一个 `https://ask-api.<你的子域>.workers.dev` 地址。
6. 把这个地址填进 `config/_default/params.toml` 的 `[askbox] api`，推送网站。
7. 打开 `https://xiyuchen.com/ask/admin/`，输入 ADMIN_TOKEN 登录。

### 让中国大陆的访客也能用（推荐）

`*.workers.dev` 在大陆访问不了。把 xiyuchen.com 的 DNS（现在在 Cosmotown）迁到 Cloudflare（免费；GitHub Pages 照常工作），然后在 `wrangler.toml` 里取消注释 `routes = [{ pattern = "ask.xiyuchen.com", custom_domain = true }]`，重新部署，再把 `api` 改成 `https://ask.xiyuchen.com`。

### 可选

- **防机器人**：在 Cloudflare 后台创建一个 Turnstile 小组件，把 site key 填进 `params.toml` 的 `turnstileSiteKey`，再 `npx wrangler secret put TURNSTILE_SECRET`。
- **新问题推送到手机**：装 [ntfy](https://ntfy.sh) App 订阅一个只有你知道的主题名，然后 `npx wrangler secret put NOTIFY_URL`，值填 `https://ntfy.sh/<主题名>`。

## API 一览

| 方法 | 路径 | 谁可以用 | 作用 |
| --- | --- | --- | --- |
| GET | `/api/threads?cursor=&limit=` | 所有人 | 已公开的问答，最新回复在前 |
| POST | `/api/threads` | 所有人 | 提问 `{ body, lang, turnstileToken? }`，返回 `askerToken` |
| GET | `/api/threads/:id` | 所有人 / 提问者 / 你 | 单个问题（提问者带 `X-Asker-Token` 能看到未公开部分） |
| POST | `/api/threads/:id/messages` | 提问者 / 你 | 追问（带 `X-Asker-Token`）或回复（带管理员令牌） |
| POST | `/api/threads/lookup` | 提问者 | `{ items: [{ id, token }] }` 取回自己的所有问题 |
| GET | `/api/admin/threads?filter=pending\|answered\|hidden\|all` | 你 | 管理列表 |
| PATCH | `/api/admin/threads/:id` | 你 | `{ status: "open"\|"hidden", closed: bool }` |
| DELETE | `/api/admin/threads/:id` | 你 | 删除整个问题 |
| PATCH / DELETE | `/api/admin/messages/:id` | 你 | 编辑自己的回复 / 删除一条消息 |

管理员请求带 `Authorization: Bearer <ADMIN_TOKEN>`。
