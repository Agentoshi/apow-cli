#!/usr/bin/env bash
# APoW Cloud GPU Mining — Vast.ai RTX 4090 Setup
#
# Prerequisites:
#   pip install vastai
#   vastai set api-key <YOUR_API_KEY>
#   Upload SSH key at https://cloud.vast.ai/manage-keys/
#
# Usage:
#   ./vast-setup.sh              # Find offers, rent, deploy grinder
#   ./vast-setup.sh status       # Check running instance
#   ./vast-setup.sh destroy      # Tear down instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GPU_DIR="$SCRIPT_DIR/gpu"
CUDA_SRC="$GPU_DIR/grinder-cuda.cu"
STATE_FILE="$SCRIPT_DIR/.vast-instance"

# ── Helpers ──

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { log "ERROR: $*"; exit 1; }

get_instance_id() {
    [[ -f "$STATE_FILE" ]] && cat "$STATE_FILE" || echo ""
}

get_ssh_cmd() {
    local id="$1"
    local info
    info=$(vastai show instance "$id" --raw 2>/dev/null)
    local ip port
    ip=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ssh_host',''))" 2>/dev/null)
    port=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ssh_port',''))" 2>/dev/null)
    if [[ -z "$ip" || -z "$port" ]]; then
        die "Cannot get SSH details for instance $id"
    fi
    echo "$ip $port"
}

# ── Commands ──

cmd_status() {
    local id
    id=$(get_instance_id)
    if [[ -z "$id" ]]; then
        log "No active instance. Run './vast-setup.sh' to create one."
        return
    fi
    log "Instance ID: $id"
    vastai show instance "$id"
}

cmd_destroy() {
    local id
    id=$(get_instance_id)
    if [[ -z "$id" ]]; then
        log "No active instance."
        return
    fi
    log "Destroying instance $id..."
    vastai destroy instance "$id"
    rm -f "$STATE_FILE"
    log "Done. Instance destroyed."
}

cmd_setup() {
    [[ -f "$CUDA_SRC" ]] || die "CUDA source not found: $CUDA_SRC"

    # Check for existing instance
    local existing_id
    existing_id=$(get_instance_id)
    if [[ -n "$existing_id" ]]; then
        log "Existing instance found: $existing_id"
        log "Run './vast-setup.sh destroy' first, or './vast-setup.sh status' to check it."
        return
    fi

    # 1. Search for RTX 4090 offers
    log "Searching for RTX 4090 offers..."
    vastai search offers \
        'gpu_name=RTX_4090 num_gpus=1 reliability>0.98 direct_port_count>0 disk_space>=20' \
        -o 'dph+' \
        --limit 5

    echo ""
    read -rp "Enter offer ID to rent (or 'q' to quit): " OFFER_ID
    [[ "$OFFER_ID" == "q" ]] && exit 0

    # 2. Create instance
    log "Creating instance from offer $OFFER_ID..."
    local create_output
    create_output=$(vastai create instance "$OFFER_ID" \
        --image nvidia/cuda:12.4.1-devel-ubuntu22.04 \
        --disk 20 \
        --ssh \
        --direct 2>&1)

    local instance_id
    instance_id=$(echo "$create_output" | grep -oP 'new contract is \K\d+' || echo "")
    if [[ -z "$instance_id" ]]; then
        instance_id=$(echo "$create_output" | grep -oP '\d+' | tail -1)
    fi
    if [[ -z "$instance_id" ]]; then
        die "Failed to extract instance ID from: $create_output"
    fi

    echo "$instance_id" > "$STATE_FILE"
    log "Instance created: $instance_id"

    # 3. Wait for instance to be ready
    log "Waiting for instance to start (this can take 1-3 minutes)..."
    for i in $(seq 1 60); do
        local status
        status=$(vastai show instance "$instance_id" --raw 2>/dev/null | \
            python3 -c "import sys,json; print(json.load(sys.stdin).get('actual_status',''))" 2>/dev/null || echo "")
        if [[ "$status" == "running" ]]; then
            log "Instance is running!"
            break
        fi
        printf "."
        sleep 5
    done
    echo ""

    # 4. Get SSH details
    local ssh_info ip port
    ssh_info=$(get_ssh_cmd "$instance_id")
    ip=$(echo "$ssh_info" | cut -d' ' -f1)
    port=$(echo "$ssh_info" | cut -d' ' -f2)
    log "SSH: ssh -p $port root@$ip"

    # 5. Upload and compile CUDA grinder
    log "Uploading CUDA grinder source..."
    scp -o StrictHostKeyChecking=no -P "$port" "$CUDA_SRC" "root@$ip:/workspace/grinder-cuda.cu"

    log "Compiling on GPU instance (nvcc -O3 -arch=sm_89)..."
    ssh -o StrictHostKeyChecking=no -p "$port" "root@$ip" \
        "cd /workspace && nvcc grinder-cuda.cu -o grinder-cuda -std=c++17 -O3 -arch=sm_89"

    log "Verifying binary..."
    ssh -o StrictHostKeyChecking=no -p "$port" "root@$ip" \
        "ls -la /workspace/grinder-cuda && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"

    # 6. Output env vars for speed-miner.js
    echo ""
    log "=== Setup complete! ==="
    echo ""
    echo "Add to your .env or export:"
    echo "  export GRINDER_MODE=remote"
    echo "  export VAST_IP=$ip"
    echo "  export VAST_PORT=$port"
    echo ""
    echo "Test manually:"
    echo "  ssh -p $port root@$ip '/workspace/grinder-cuda <challenge> <address> <target>'"
    echo ""
    echo "Start mining:"
    echo "  GRINDER_MODE=remote VAST_IP=$ip VAST_PORT=$port node local/speed-miner.js"
}

# ── Main ──

case "${1:-setup}" in
    status)  cmd_status ;;
    destroy) cmd_destroy ;;
    setup|"") cmd_setup ;;
    *) echo "Usage: $0 [setup|status|destroy]"; exit 1 ;;
esac
