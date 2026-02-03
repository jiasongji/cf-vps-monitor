#!/bin/bash
# =========================================================
# Cloudflare Worker VPS Monitor - 全能管理脚本
# 集成功能：三网丢包检测 | Uptime上报 | 服务管理 | 一键安装
# =========================================================

# --- 基础配置 ---
INSTALL_DIR="/opt/vps-monitor"
SERVICE_NAME="vps-monitor"
VERSION="2.0.0 (Ping Enhanced)"

# --- 颜色定义 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
SKYBLUE='\033[0;36m'
PLAIN='\033[0m'

# --- 辅助函数 ---
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}错误: 必须使用 root 权限运行此脚本${PLAIN}"
        echo "请使用 sudo su 切换到 root 用户后再试"
        exit 1
    fi
}

# --- 核心组件生成函数 ---

# 1. 生成 Python 丢包检测脚本
create_ping_daemon() {
    cat > "$INSTALL_DIR/ping_daemon.py" << 'EOF'
import socket
import time
import json
import threading
from collections import deque

# 目标地址配置
TARGETS = {
    "cu": "www.tynews.com.cn",
    "ct": "www.chinaccs.cn",
    "cm": "sx.10086.cn"
}
PORT = 80
HISTORY_LEN = 100 
INTERVAL = 2      
OUTPUT_FILE = "/tmp/vps_monitor_ping.json"

history = {
    "cu": deque(maxlen=HISTORY_LEN),
    "ct": deque(maxlen=HISTORY_LEN),
    "cm": deque(maxlen=HISTORY_LEN)
}

def tcp_ping(host, port):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.5)
        s.connect((host, port))
        s.close()
        return True
    except:
        return False

def worker(carrier, host):
    while True:
        result = tcp_ping(host, PORT)
        history[carrier].append(result)
        time.sleep(INTERVAL)

def data_writer():
    while True:
        data = {}
        for carrier, q in history.items():
            if len(q) == 0:
                data[carrier] = 0
            else:
                lost_count = list(q).count(False)
                loss_rate = int((lost_count / len(q)) * 100)
                data[carrier] = loss_rate
        try:
            with open(OUTPUT_FILE, 'w') as f:
                json.dump(data, f)
        except:
            pass
        time.sleep(5)

for carrier, host in TARGETS.items():
    t = threading.Thread(target=worker, args=(carrier, host))
    t.daemon = True
    t.start()

writer = threading.Thread(target=data_writer)
writer.daemon = True
writer.start()

while True:
    time.sleep(60)
EOF
}

# 2. 生成主监控脚本 (Bash)
create_monitor_script() {
    local url=$1
    local key=$2
    local id=$3
    local interval=$4

    cat > "$INSTALL_DIR/monitor.sh" << EOF
#!/bin/bash
WORKDIR="$INSTALL_DIR"
cd "\$WORKDIR" || exit 1

API_KEY="$key"
SERVER_ID="$id"
WORKER_URL="$url"
INTERVAL=$interval

# 检查 Python 进程
check_ping_daemon() {
    if ! pgrep -f "ping_daemon.py" > /dev/null; then
        nohup python3 "\$WORKDIR/ping_daemon.py" > /dev/null 2>&1 &
    fi
}

# 读取 Ping 数据
get_ping_data() {
    if [ -f "/tmp/vps_monitor_ping.json" ]; then
        cat "/tmp/vps_monitor_ping.json"
    else
        echo '{"cu":0,"ct":0,"cm":0}'
    fi
}

log() {
  echo "\$(date '+%Y-%m-%d %H:%M:%S') - \$1"
}

get_uptime() {
  cat /proc/uptime | awk '{print \$1}' | cut -d. -f1
}

get_cpu_usage() {
  cpu_usage=\$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - \$1}')
  cpu_load=\$(cat /proc/loadavg | awk '{print \$1", "\$2", "\$3}')
  echo "{\"usage_percent\":\$cpu_usage,\"load_avg\":[\$cpu_load]}"
}

get_memory_usage() {
  total=\$(free -k | grep Mem | awk '{print \$2}')
  used=\$(free -k | grep Mem | awk '{print \$3}')
  free=\$(free -k | grep Mem | awk '{print \$4}')
  usage_percent=\$(echo "scale=1; \$used * 100 / \$total" | bc)
  echo "{\"total\":\$total,\"used\":\$used,\"free\":\$free,\"usage_percent\":\$usage_percent}"
}

get_disk_usage() {
  disk_info=\$(df -k / | tail -1)
  total=\$(echo "\$disk_info" | awk '{print \$2 / 1024 / 1024}')
  used=\$(echo "\$disk_info" | awk '{print \$3 / 1024 / 1024}')
  free=\$(echo "\$disk_info" | awk '{print \$4 / 1024 / 1024}')
  usage_percent=\$(echo "\$disk_info" | awk '{print \$5}' | tr -d '%')
  echo "{\"total\":\$total,\"used\":\$used,\"free\":\$free,\"usage_percent\":\$usage_percent}"
}

get_network_usage() {
  if ! command -v ifstat &> /dev/null; then
    echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
    return
  fi
  
  interface=\$(ip route | grep default | awk '{print \$5}')
  network_speed=\$(ifstat -i "\$interface" 1 1 | tail -1)
  download_speed=\$(echo "\$network_speed" | awk '{print \$1 * 1024}')
  upload_speed=\$(echo "\$network_speed" | awk '{print \$2 * 1024}')
  rx_bytes=\$(cat /proc/net/dev | grep "\$interface" | awk '{print \$2}')
  tx_bytes=\$(cat /proc/net/dev | grep "\$interface" | awk '{print \$10}')
  
  echo "{\"upload_speed\":\$upload_speed,\"download_speed\":\$download_speed,\"total_upload\":\$tx_bytes,\"total_download\":\$rx_bytes}"
}

report_metrics() {
  check_ping_daemon

  timestamp=\$(date +%s)
  cpu=\$(get_cpu_usage)
  memory=\$(get_memory_usage)
  disk=\$(get_disk_usage)
  network=\$(get_network_usage)
  ping=\$(get_ping_data)
  uptime=\$(get_uptime)
  
  data="{\"timestamp\":\$timestamp,\"cpu\":\$cpu,\"memory\":\$memory,\"disk\":\$disk,\"network\":\$network,\"ping\":\$ping,\"uptime\":\$uptime}"
  
  response=\$(curl -s -X POST "\$WORKER_URL/api/report/\$SERVER_ID" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: \$API_KEY" \
    -d "\$data")
  
  if [[ "\$response" == *"success"* ]]; then
    log "数据上报成功"
  else
    log "数据上报失败: \$response"
  fi
}

log "监控脚本启动"
nohup python3 "\$WORKDIR/ping_daemon.py" > /dev/null 2>&1 &

while true; do
  report_metrics
  sleep \$INTERVAL
done
EOF
}

# 3. 生成 Systemd 服务文件
create_service_file() {
    cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=VPS Monitor Service (CF Workers)
After=network.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/monitor.sh
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF
}

# --- 功能菜单函数 ---

# 1. 安装服务
install_service() {
    echo -e "${YELLOW}开始安装监控服务...${PLAIN}"
    
    # 获取参数 (如果是交互模式)
    if [ -z "$1" ]; then
        read -p "请输入 Worker URL (例: https://status.abc.com): " input_url
        read -p "请输入 服务器 ID: " input_id
        read -p "请输入 API Key: " input_key
        read -p "请输入 上报间隔 (秒, 默认60): " input_interval
        input_interval=${input_interval:-60}
    else
        input_url=$1
        input_id=$2
        input_key=$3
        input_interval=$4
    fi

    # 简单校验
    if [ -z "$input_url" ] || [ -z "$input_id" ] || [ -z "$input_key" ]; then
        echo -e "${RED}错误: 参数不完整!${PLAIN}"
        return
    fi
    
    # 清理旧环境
    echo -e "${SKYBLUE}> 清理旧服务...${PLAIN}"
    systemctl stop $SERVICE_NAME >/dev/null 2>&1
    systemctl disable $SERVICE_NAME >/dev/null 2>&1
    pkill -f "ping_daemon.py" >/dev/null 2>&1
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"

    # 安装依赖
    echo -e "${SKYBLUE}> 安装依赖组件...${PLAIN}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y curl python3 ifstat bc
    elif command -v yum >/dev/null 2>&1; then
        yum install -y curl python3 ifstat bc
    elif command -v apk >/dev/null 2>&1; then
        apk add curl python3 ifstat bc coreutils
    else
        echo -e "${RED}无法自动安装依赖，请手动安装: curl, python3, ifstat, bc${PLAIN}"
    fi

    # 生成文件
    echo -e "${SKYBLUE}> 写入脚本文件...${PLAIN}"
    create_ping_daemon
    create_monitor_script "$input_url" "$input_key" "$input_id" "$input_interval"
    create_service_file

    chmod +x "$INSTALL_DIR/monitor.sh"
    
    # 启动服务
    echo -e "${SKYBLUE}> 启动服务...${PLAIN}"
    systemctl daemon-reload
    systemctl enable $SERVICE_NAME
    systemctl start $SERVICE_NAME
    
    echo -e "${GREEN}✅ 安装完成! 请等待约30秒以生成初始丢包数据。${PLAIN}"
}

# 2. 启动服务
start_service() {
    systemctl start $SERVICE_NAME
    echo -e "${GREEN}服务已启动${PLAIN}"
}

# 3. 停止服务
stop_service() {
    systemctl stop $SERVICE_NAME
    pkill -f "ping_daemon.py"
    echo -e "${YELLOW}服务已停止 (后台 Python 进程已清理)${PLAIN}"
}

# 4. 重启服务
restart_service() {
    systemctl stop $SERVICE_NAME
    pkill -f "ping_daemon.py"
    sleep 1
    systemctl start $SERVICE_NAME
    echo -e "${GREEN}服务已重启${PLAIN}"
}

# 5. 查看状态
check_status() {
    echo -e "${SKYBLUE}--- Systemd 服务状态 ---${PLAIN}"
    systemctl status $SERVICE_NAME | grep -E "Active|loaded"
    echo -e "${SKYBLUE}--- 后台进程状态 ---${PLAIN}"
    if pgrep -f "ping_daemon.py" > /dev/null; then
        echo -e "Ping守护进程: ${GREEN}运行中${PLAIN}"
    else
        echo -e "Ping守护进程: ${RED}未运行${PLAIN}"
    fi
    echo -e "${SKYBLUE}--- 实时数据文件 ---${PLAIN}"
    if [ -f "/tmp/vps_monitor_ping.json" ]; then
         cat /tmp/vps_monitor_ping.json
         echo ""
    else
         echo -e "${YELLOW}暂无数据文件 (服务可能刚启动)${PLAIN}"
    fi
}

# 6. 查看日志
view_log() {
    echo -e "${YELLOW}按 Ctrl+C 退出日志查看${PLAIN}"
    journalctl -u $SERVICE_NAME -f
}

# 7. 配置参数 (简单版：重新安装)
config_params() {
    echo -e "${YELLOW}当前配置逻辑为覆盖安装，请准备好新的参数${PLAIN}"
    install_service
}

# 8. 测试连接
test_connection() {
    if [ ! -f "$INSTALL_DIR/monitor.sh" ]; then
        echo -e "${RED}未找到监控脚本，请先安装服务${PLAIN}"
        return
    fi
    echo -e "${SKYBLUE}正在尝试手动执行一次上报 (不会在后台运行)...${PLAIN}"
    # 临时执行
    bash "$INSTALL_DIR/monitor.sh" &
    PID=$!
    sleep 5
    kill $PID 2>/dev/null
    echo -e "\n${YELLOW}测试结束，请查看上方是否有 '数据上报成功' 字样${PLAIN}"
}

# 9. 卸载服务
uninstall_service() {
    read -p "确定要彻底卸载监控服务吗? [y/n]: " choice
    if [[ "$choice" == "y" ]]; then
        systemctl stop $SERVICE_NAME
        systemctl disable $SERVICE_NAME
        rm -f "/etc/systemd/system/$SERVICE_NAME.service"
        systemctl daemon-reload
        pkill -f "ping_daemon.py"
        rm -rf "$INSTALL_DIR"
        echo -e "${GREEN}服务已彻底卸载${PLAIN}"
    else
        echo -e "操作取消"
    fi
}

# --- 菜单界面 ---
show_menu() {
    clear
    echo -e "=================================="
    echo -e "    VPS监控服务管理菜单 ${VERSION}"
    echo -e "=================================="
    echo -e ""
    echo -e "${GREEN}1.${PLAIN} 安装监控服务"
    echo -e "${GREEN}2.${PLAIN} 启动监控服务"
    echo -e ""
    echo -e "${GREEN}3.${PLAIN} 停止监控服务"
    echo -e "${GREEN}4.${PLAIN} 重启监控服务"
    echo -e ""
    echo -e "${GREEN}5.${PLAIN} 查看服务状态"
    echo -e "${GREEN}6.${PLAIN} 查看运行日志"
    echo -e ""
    echo -e "${GREEN}7.${PLAIN} 配置监控参数"
    echo -e "${GREEN}8.${PLAIN} 测试连接"
    echo -e ""
    echo -e "特殊操作:"
    echo -e "${RED}9.${PLAIN} 彻底卸载服务"
    echo -e "${YELLOW}0.${PLAIN} 退出"
    echo -e ""
    read -p "请选择操作 (0-9): " choice
    
    case $choice in
        1) install_service ;;
        2) start_service ;;
        3) stop_service ;;
        4) restart_service ;;
        5) check_status ;;
        6) view_log ;;
        7) config_params ;;
        8) test_connection ;;
        9) uninstall_service ;;
        0) exit 0 ;;
        *) echo -e "${RED}无效输入${PLAIN}" ;;
    esac
    
    if [[ "$choice" != "0" ]]; then
        echo -e ""
        read -p "按回车键返回主菜单..."
        show_menu
    fi
}

# --- 主逻辑入口 ---

check_root

# 如果带参数，进入一键安装模式 (兼容 Worker 生成的脚本)
if [[ $# -gt 0 ]]; then
    while [[ $# -gt 0 ]]; do
        case $1 in
            -u|--url) ARG_URL="$2"; shift 2 ;;
            -s|--server) ARG_ID="$2"; shift 2 ;;
            -k|--key) ARG_KEY="$2"; shift 2 ;;
            -i|--interval) ARG_INTERVAL="$2"; shift 2 ;;
            *) shift ;;
        esac
    done
    
    if [ ! -z "$ARG_URL" ] && [ ! -z "$ARG_ID" ] && [ ! -z "$ARG_KEY" ]; then
        ARG_INTERVAL=${ARG_INTERVAL:-60}
        install_service "$ARG_URL" "$ARG_ID" "$ARG_KEY" "$ARG_INTERVAL"
    else
        echo -e "${RED}参数不完整，请检查 -u, -s, -k 是否都已提供${PLAIN}"
    fi
else
    # 无参数，进入菜单模式
    show_menu
fi
