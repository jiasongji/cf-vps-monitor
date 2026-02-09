#!/bin/bash
# =========================================================
# Cloudflare Worker VPS Monitor - 全能管理脚本
# 版本：v2.0.4 (Paranoid Mode - 强力去换行 + 故障现场记录)
# =========================================================

# --- 基础配置 ---
INSTALL_DIR="/opt/vps-monitor"
SERVICE_NAME="vps-monitor"
VERSION="2.0.4 (Paranoid)"

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

# 1. 生成 Python 丢包检测脚本 (原子写入)
create_ping_daemon() {
    cat > "$INSTALL_DIR/ping_daemon.py" << 'EOF'
import socket
import time
import json
import threading
import os
from collections import deque

# 目标地址配置
TARGETS = {
    "cu": "www.cuecp.cn",
    "ct": "www.chinaccs.cn",
    "cm": "sx.10086.cn"
}
PORT = 80
HISTORY_LEN = 100 
INTERVAL = 2      
OUTPUT_FILE = "/tmp/vps_monitor_ping.json"
TEMP_FILE = OUTPUT_FILE + ".tmp"

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
            with open(TEMP_FILE, 'w') as f:
                json.dump(data, f)
            os.replace(TEMP_FILE, OUTPUT_FILE)
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

# 2. 生成主监控脚本 (Bash, 极度偏执模式)
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

log() {
  echo "\$(date '+%Y-%m-%d %H:%M:%S') - \$1"
}

# --- 数据采集函数 (Paranoid Mode) ---
# 所有输出通过 tr -d '\n\r' 清洗，防止 JSON 断行

get_ping_data() {
    local default='{"cu":0,"ct":0,"cm":0}'
    if [ -s "/tmp/vps_monitor_ping.json" ]; then
        local content=\$(cat "/tmp/vps_monitor_ping.json")
        # 简单校验
        if [[ "\$content" == \{*\} ]]; then
            echo "\$content" | tr -d '\n\r'
            return
        fi
    fi
    echo "\$default"
}

get_uptime() {
    local up=\$(cat /proc/uptime 2>/dev/null | awk '{print \$1}' | cut -d. -f1)
    if [[ ! "\$up" =~ ^[0-9]+$ ]]; then
        echo "0"
    else
        echo "\$up" | tr -d '\n\r'
    fi
}

get_cpu_usage() {
    local cpu_usage=\$(top -bn1 2>/dev/null | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - \$1}')
    local cpu_load=\$(cat /proc/loadavg 2>/dev/null | awk '{print \$1", "\$2", "\$3}')
    
    cpu_usage=\${cpu_usage:-0}
    cpu_load=\${cpu_load:-"0, 0, 0"}
    
    # 组装前清洗
    cpu_usage=\$(echo "\$cpu_usage" | tr -d '\n\r')
    cpu_load=\$(echo "\$cpu_load" | tr -d '\n\r')
    
    echo "{\"usage_percent\":\$cpu_usage,\"load_avg\":[\$cpu_load]}"
}

get_memory_usage() {
    local mem_info=\$(free -k 2>/dev/null | grep Mem)
    local total=\$(echo "\$mem_info" | awk '{print \$2}')
    local used=\$(echo "\$mem_info" | awk '{print \$3}')
    local free=\$(echo "\$mem_info" | awk '{print \$4}')
    
    total=\${total:-0}
    used=\${used:-0}
    free=\${free:-0}
    
    local usage_percent=0
    if [ "\$total" -gt 0 ]; then
        usage_percent=\$(echo "scale=1; \$used * 100 / \$total" | bc 2>/dev/null)
    fi
    usage_percent=\${usage_percent:-0}
    
    # 清洗
    total=\$(echo "\$total" | tr -d '\n\r')
    used=\$(echo "\$used" | tr -d '\n\r')
    free=\$(echo "\$free" | tr -d '\n\r')
    usage_percent=\$(echo "\$usage_percent" | tr -d '\n\r')
    
    echo "{\"total\":\$total,\"used\":\$used,\"free\":\$free,\"usage_percent\":\$usage_percent}"
}

get_disk_usage() {
    local disk_info=\$(df -k / 2>/dev/null | tail -1)
    local total=\$(echo "\$disk_info" | awk '{print \$2 / 1024 / 1024}')
    local used=\$(echo "\$disk_info" | awk '{print \$3 / 1024 / 1024}')
    local free=\$(echo "\$disk_info" | awk '{print \$4 / 1024 / 1024}')
    local usage_percent=\$(echo "\$disk_info" | awk '{print \$5}' | tr -d '%')
    
    total=\${total:-0}
    used=\${used:-0}
    free=\${free:-0}
    usage_percent=\${usage_percent:-0}
    
    # 清洗
    total=\$(echo "\$total" | tr -d '\n\r')
    used=\$(echo "\$used" | tr -d '\n\r')
    free=\$(echo "\$free" | tr -d '\n\r')
    usage_percent=\$(echo "\$usage_percent" | tr -d '\n\r')

    echo "{\"total\":\$total,\"used\":\$used,\"free\":\$free,\"usage_percent\":\$usage_percent}"
}

get_network_usage() {
    if ! command -v ifstat &> /dev/null; then
        echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
        return
    fi
    
    local interface=\$(ip route | grep default | awk '{print \$5}')
    local net_speed=\$(ifstat -i "\$interface" 1 1 2>/dev/null | tail -1)
    
    local download=\$(echo "\$net_speed" | awk '{print \$1 * 1024}')
    local upload=\$(echo "\$net_speed" | awk '{print \$2 * 1024}')
    
    local rx=\$(cat /proc/net/dev | grep "\$interface" | head -n 1 | awk '{print \$2}')
    local tx=\$(cat /proc/net/dev | grep "\$interface" | head -n 1 | awk '{print \$10}')
    
    download=\${download:-0}
    upload=\${upload:-0}
    rx=\${rx:-0}
    tx=\${tx:-0}
    
    # 清洗
    download=\$(echo "\$download" | tr -d '\n\r')
    upload=\$(echo "\$upload" | tr -d '\n\r')
    rx=\$(echo "\$rx" | tr -d '\n\r')
    tx=\$(echo "\$tx" | tr -d '\n\r')
    
    echo "{\"upload_speed\":\$upload,\"download_speed\":\$download,\"total_upload\":\$tx,\"total_download\":\$rx}"
}

report_metrics() {
  check_ping_daemon

  timestamp=\$(date +%s)
  
  # 获取数据
  cpu=\$(get_cpu_usage)
  memory=\$(get_memory_usage)
  disk=\$(get_disk_usage)
  network=\$(get_network_usage)
  ping=\$(get_ping_data)
  uptime=\$(get_uptime)
  
  # 兜底默认值
  if [ -z "\$cpu" ]; then cpu='{"usage_percent":0,"load_avg":[0,0,0]}'; fi
  if [ -z "\$memory" ]; then memory='{"total":0,"used":0,"free":0,"usage_percent":0}'; fi
  if [ -z "\$disk" ]; then disk='{"total":0,"used":0,"free":0,"usage_percent":0}'; fi
  if [ -z "\$network" ]; then network='{"upload_speed":0,"download_speed":0,"total_upload":0,"total_download":0}'; fi
  if [ -z "\$ping" ]; then ping='{"cu":0,"ct":0,"cm":0}'; fi
  if [ -z "\$uptime" ]; then uptime=0; fi
  
  # 组装 JSON
  data="{\"timestamp\":\$timestamp,\"cpu\":\$cpu,\"memory\":\$memory,\"disk\":\$disk,\"network\":\$network,\"ping\":\$ping,\"uptime\":\$uptime}"
  
  response=\$(curl -s -X POST "\$WORKER_URL/api/report/\$SERVER_ID" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: \$API_KEY" \
    -d "\$data")
  
  if [[ "\$response" == *"success"* ]]; then
    log "数据上报成功"
  else
    # 关键：故障现场记录！
    log "数据上报失败: \$response"
    log "【调试】失败时的 JSON 数据: \$data"
  fi
}

install_dependencies() {
  log "检查并安装依赖..."
  local pkg_manager=""
  
  if command -v apt-get &> /dev/null; then
    pkg_manager="apt-get"
  elif command -v yum &> /dev/null; then
    pkg_manager="yum"
  else
    log "警告：未找到 apt-get 或 yum，尝试直接运行。如果失败请手动安装依赖。"
    return 1
  fi
  
  if [ ! -z "\$pkg_manager" ]; then
      \$pkg_manager update -y 2>/dev/null
      \$pkg_manager install -y bc curl ifstat python3
  fi
  return 0
}

main() {
  log "VPS监控脚本启动 (Paranoid Mode)"
  install_dependencies
  nohup python3 "\$WORKDIR/ping_daemon.py" > /dev/null 2>&1 &
  while true; do
    report_metrics
    sleep \$INTERVAL
  done
}

main
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

    if [ -z "$input_url" ] || [ -z "$input_id" ] || [ -z "$input_key" ]; then
        echo -e "${RED}错误: 参数不完整!${PLAIN}"
        return
    fi
    
    echo -e "${SKYBLUE}> 清理旧服务...${PLAIN}"
    systemctl stop $SERVICE_NAME >/dev/null 2>&1
    systemctl disable $SERVICE_NAME >/dev/null 2>&1
    pkill -f "ping_daemon.py" >/dev/null 2>&1
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"

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

    echo -e "${SKYBLUE}> 写入脚本文件...${PLAIN}"
    create_ping_daemon
    create_monitor_script "$input_url" "$input_key" "$input_id" "$input_interval"
    create_service_file

    chmod +x "$INSTALL_DIR/monitor.sh"
    
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
    if [ -s "/tmp/vps_monitor_ping.json" ]; then
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

# 7. 配置参数
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
        show_menu
    fi
else
    show_menu
fi
