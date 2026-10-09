# 本项目开发服务安全规则

- 开发和构建只使用 `npm run dev -- --port <端口>`、`npm run build`；它们经过 `scripts/next_safe.py` 的独立资源保护。不要绕过脚本直接运行 `next`、`npx next`，也不要启用 Turbopack。
- 使用 `.nvmrc` 指定的 Node 22 LTS；先用 `npm run check:safety` 检查环境。
- 同时只运行一个开发或构建任务。保护触发后先检查报错和资源，不自动循环重启、不提高保护阈值来掩盖问题。
- 停止服务时正常中断原启动终端，等待保护脚本清理本次进程组。不要使用 `killall node` 或 `pkill node`，以免影响其他应用。
- 保持 Next.js、PostCSS 的项目根目录和 Tailwind 显式扫描范围，不删除用户上级目录的锁文件来处理根目录误判。
- 2026-10-07 曾发生编译异常伴随超过 1,200 个 Node 进程、内存及交换空间耗尽，最终触发系统 watchdog。改动构建配置时必须验证进程数量和退出清理。
