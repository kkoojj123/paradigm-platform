#!/bin/bash
# 范式约稿平台 v2 自动保活脚本
# 每 30 秒检查一次，崩了就自动重启

PORT=5056
WORKDIR="/home/node/.openclaw/workspace/paradigm-platform-v2"
LOGFILE="/tmp/paradigm-keepalive.log"

restart() {
    # 只杀 v2 进程，不影响其他服务
    pkill -f "paradigm-platform-v2.*app.py" 2>/dev/null
    sleep 1
    cd "$WORKDIR" && nohup python3 -u app.py >> "$LOGFILE" 2>&1 &
    echo "$(date '+%Y-%m-%d %H:%M:%S') [重启] 服务已启动 (PID: $!)" >> "$LOGFILE"
    sleep 2
}

echo "$(date '+%Y-%m-%d %H:%M:%S') [启动] 保活脚本开始运行" >> "$LOGFILE"

while true; do
    if ! curl -s --noproxy '*' http://127.0.0.1:$PORT/ >/dev/null 2>&1; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [检测] 服务无响应，正在重启..." >> "$LOGFILE"
        restart
    fi
    sleep 30
done
