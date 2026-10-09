# 本项目开发服务安全规则

ChatGit 现基于 LibreChat 开发：`app/` 是固定在 `e1dfc10449ff713faffacd60273fddcfe2c0a698` 导入的 LibreChat，`legacy/chatgit/` 只是旧版 Next.js 实现的参考，不再运行其开发服务。

- 只用根目录的受保护入口：`npm run check:safety`、`npm run setup:app`（依赖安装）、`npm run build`、`npm run dev -- --port <端口>`、`npm run test:safety`。它们经过 `scripts/next_safe.py` 的独立进程组保护。不要在 `app/` 里直接运行 `npm ci`、`npm run build`、`npm run frontend`、`npx turbo`、`vite`、`npm run backend` 或 `node api/server/index.js`；客户端的上游 `build` 脚本会把 Node 堆强制提到 8 GiB，受保护构建改用 `build:file`。
- 使用 `.nvmrc` 固定的 Node 24.16.0（与上游 `app/.nvmrc` 一致），由 `.agents/setup` 安装；系统自带的 Node 26 不用于本项目。先用 `npm run check:safety` 检查环境。
- 同时只运行一个安装、开发或构建任务。保护上限为每个进程组 32 个进程、6 GiB RSS、可用磁盘不低于 10 GiB、每个 Node 进程 2 GiB 堆。保护触发后先检查报错和资源，不自动循环重启、不提高阈值来掩盖问题。
- 停止服务时正常中断原启动终端（或 `amp orb service stop chatgit`），等待保护脚本清理本次进程组。不要使用 `killall node`、`pkill node`、`pkill mongod`，以免影响其他应用；本 orb 中仓库外的 `librechat-eval`、`librechat-model` 实验服务不要停止。
- `.chatgit/` 保存自动生成的本地密钥、MongoDB 数据和日志：不要删除、不要提交、不要输出其中的值；不要轮换已有的 `CREDS_KEY`/`CREDS_IV`，也不要关闭应用认证。
- `app/chatgit.yaml` 只配置真实服务（用户自填密钥与地址），不要把假模型或本地测试夹具设为默认；验证夹具通过被忽略的 `.chatgit/local.env` 中的 `CONFIG_PATH` 覆盖。
- 不删除用户上级目录的锁文件来处理根目录误判。
- 2026-10-07 曾发生编译异常伴随超过 1,200 个 Node 进程、内存及交换空间耗尽，最终触发系统 watchdog。改动构建配置或保护脚本时必须验证进程数量和退出清理（`npm run test:safety`）。
