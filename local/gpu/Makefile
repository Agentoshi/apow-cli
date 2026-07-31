# APoW GPU Nonce Grinder — Build Targets
#
# Metal (macOS Apple Silicon):  make metal
# CUDA (Vast.ai RTX 4090):     make cuda
# CPU (reference/fallback):     make cpu

.PHONY: all metal cuda cpu clean

# ── Metal (macOS only) ──
metal: grinder-gpu

grinder-gpu: grinder.m keccak.metal
	clang -O2 -framework Metal -framework Foundation grinder.m -o grinder-gpu

# ── CUDA (Linux, requires nvcc + CUDA toolkit) ──
# sm_89 = Ada Lovelace (RTX 4090). Change for other GPUs:
#   sm_86 = Ampere (RTX 3090), sm_90 = Hopper (H100)
CUDA_ARCH ?= sm_89

cuda: grinder-cuda

grinder-cuda: grinder-cuda.cu
	nvcc grinder-cuda.cu -o grinder-cuda -std=c++17 -O3 -arch=$(CUDA_ARCH)

# ── CPU (portable reference) ──
cpu: grinder-cpu

grinder-cpu: grinder-cpu.c
	clang -O2 -pthread grinder-cpu.c -o grinder-cpu

# ── Test harness (Metal, verifies GPU vs CPU keccak) ──
test: test_keccak

test_keccak: test_keccak.m
	clang -O2 -framework Metal -framework Foundation test_keccak.m -o test_keccak

# ── Cleanup ──
clean:
	rm -f grinder-gpu grinder-cuda grinder-cpu test_keccak *.metallib
