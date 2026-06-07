# 部署说明

## 第一次部署（5步）

### 前提：安装 Wrangler
```bash
npm install -g wrangler
wrangler login
```

### 1. 创建 D1 数据库
```bash
wrangler d1 create paradigm-platform
```
复制输出的 `database_id`，填入 `wrangler.toml` 的 `PLACEHOLDER_REPLACE_AFTER_CREATE`

### 2. 创建 R2 存储桶
```bash
wrangler r2 bucket create paradigm-uploads
wrangler r2 bucket create paradigm-uploads --jurisdiction fedramp  # (可选，数据在美国)
```
开启 R2 public access（在 Cloudflare 控制台 R2 页面 → Buckets → paradigm-uploads → Settings → Public Access）

### 3. 初始化数据库
```bash
wrangler d1 execute paradigm-platform --file=schema.sql
```

### 4. 更新 wrangler.toml
把 `PLACEHOLDER_REPLACE_AFTER_CREATE` 替换为第1步得到的 `database_id`

### 5. 部署
```bash
wrangler deploy
```

部署完成后会输出域名：`paradigm-platform.YOUR_SUBDOMAIN.workers.dev`

## 后续更新（只需1条命令）
```bash
wrangler deploy
```

## 运营账号
- 用户名：operator
- 密码：xhs2026

## 环境变量（可选修改）
在 `wrangler.toml` 的 `[vars]` 中修改 `SECRET_KEY`
