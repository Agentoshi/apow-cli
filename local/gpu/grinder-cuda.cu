/*
 * APoW GPU Nonce Grinder — CUDA (RTX 4090) v5: Daemon Mode
 *
 * Grinds nonces for up to 8 addresses simultaneously in one kernel launch.
 * Threads are partitioned across addresses — all addresses grind in parallel.
 * Found nonces are streamed to stdout as they're discovered.
 *
 * One-shot mode (backwards compatible):
 *   Usage: ./grinder-cuda <challenge_hex> <target_hex> <addr1_hex> [addr2_hex] ...
 *
 * Daemon mode (persistent — eliminates CUDA init overhead per grind):
 *   Usage: ./grinder-cuda --daemon
 *   Stdin:  <challenge_hex> <target_hex> [W<weight>] <addr1_hex> ...\n
 *           ABORT\n  (cancel current grind, wait for next)
 *   Stdout: F <addr_index> <nonce_decimal> <elapsed_seconds>
 *           D <total_attempts> <elapsed_seconds>
 *           READY\n  (daemon ready for next challenge)
 *
 * Build: nvcc grinder-cuda.cu -o grinder-cuda -std=c++17 -O3 -arch=sm_89
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <ctime>
#include <chrono>
#include <csignal>
#include <unistd.h>
#include <sys/select.h>

#define MAX_ADDRS 8
#define MAX_LINE 4096

// Signal state — declared early so run_grind can check it
static volatile sig_atomic_t got_signal = 0;

// ── Keccak round constants ──

__constant__ uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

__device__ __forceinline__ uint64_t bswap64(uint64_t x) {
    uint32_t lo = (uint32_t)x;
    uint32_t hi = (uint32_t)(x >> 32);
    return ((uint64_t)__byte_perm(lo, 0, 0x0123) << 32) |
           (uint64_t)__byte_perm(hi, 0, 0x0123);
}

#define CHI(a0, a1, a2, a3, a4) { \
    uint64_t c0=a0, c1=a1, c2=a2, c3=a3, c4=a4; \
    a0 = c0 ^ (~c1 & c2); \
    a1 = c1 ^ (~c2 & c3); \
    a2 = c2 ^ (~c3 & c4); \
    a3 = c3 ^ (~c4 & c0); \
    a4 = c4 ^ (~c0 & c1); \
}

// ── Structures ──

struct GrindParams {
    uint64_t pre_state[MAX_ADDRS][25];  // Pre-absorbed state per address
    uint64_t target_be[4];               // Same target for all
    uint64_t start_nonce;
    uint32_t num_addrs;
    uint32_t threads_per_addr[MAX_ADDRS]; // Per-address thread count (for weighting)
    uint32_t thread_offset[MAX_ADDRS];    // Cumulative offset: sum of threads_per_addr[0..i-1]
};

struct GrindResult {
    uint32_t found[MAX_ADDRS];           // Per-address found flag
    uint64_t nonce[MAX_ADDRS];           // Per-address winning nonce
};

// ── GPU kernel: threads partitioned across addresses ──

__global__ void grind_kernel(const GrindParams* __restrict__ params, GrindResult* result) {
    uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;

    // Find which address this thread belongs to via cumulative offsets
    uint32_t addr_idx = 0;
    uint32_t n = params->num_addrs;
    for (uint32_t i = 0; i < n; i++) {
        if (tid < params->thread_offset[i] + params->threads_per_addr[i]) {
            addr_idx = i;
            break;
        }
    }

    uint64_t local_tid = tid - params->thread_offset[addr_idx];
    if (local_tid >= params->threads_per_addr[addr_idx]) return;
    if (result->found[addr_idx]) return;

    uint64_t nonce = params->start_nonce + tid;  // Global unique nonce per thread

    // Load pre-absorbed state for this address
    const uint64_t* ps = params->pre_state[addr_idx];
    uint64_t s00 = ps[0],  s01 = ps[1],  s02 = ps[2],  s03 = ps[3],  s04 = ps[4],
             s05 = ps[5],  s06 = ps[6],  s07 = ps[7],  s08 = ps[8],  s09 = ps[9],
             s10 = ps[10], s11 = ps[11], s12 = ps[12], s13 = ps[13], s14 = ps[14],
             s15 = ps[15], s16 = ps[16], s17 = ps[17], s18 = ps[18], s19 = ps[19],
             s20 = ps[20], s21 = ps[21], s22 = ps[22], s23 = ps[23], s24 = ps[24];

    // XOR nonce into words 9 and 10
    uint32_t nhi = (uint32_t)(nonce >> 32);
    uint32_t nlo = (uint32_t)(nonce);
    s09 ^= (uint64_t)__byte_perm(nhi, 0, 0x0123) << 32;
    s10 ^= (uint64_t)__byte_perm(nlo, 0, 0x0123);

    // ── Keccak-f1600: 24 rounds ──
    for (int r = 0; r < 24; r++) {
        uint64_t bc0 = s00^s05^s10^s15^s20, bc1 = s01^s06^s11^s16^s21,
                 bc2 = s02^s07^s12^s17^s22, bc3 = s03^s08^s13^s18^s23,
                 bc4 = s04^s09^s14^s19^s24;
        uint64_t t0 = bc4^rotl64(bc1,1), t1 = bc0^rotl64(bc2,1),
                 t2 = bc1^rotl64(bc3,1), t3 = bc2^rotl64(bc4,1),
                 t4 = bc3^rotl64(bc0,1);
        s00^=t0; s05^=t0; s10^=t0; s15^=t0; s20^=t0;
        s01^=t1; s06^=t1; s11^=t1; s16^=t1; s21^=t1;
        s02^=t2; s07^=t2; s12^=t2; s17^=t2; s22^=t2;
        s03^=t3; s08^=t3; s13^=t3; s18^=t3; s23^=t3;
        s04^=t4; s09^=t4; s14^=t4; s19^=t4; s24^=t4;

        uint64_t tmp, t = s01;
        tmp=s10; s10=rotl64(t, 1); t=tmp; tmp=s07; s07=rotl64(t, 3); t=tmp;
        tmp=s11; s11=rotl64(t, 6); t=tmp; tmp=s17; s17=rotl64(t,10); t=tmp;
        tmp=s18; s18=rotl64(t,15); t=tmp; tmp=s03; s03=rotl64(t,21); t=tmp;
        tmp=s05; s05=rotl64(t,28); t=tmp; tmp=s16; s16=rotl64(t,36); t=tmp;
        tmp=s08; s08=rotl64(t,45); t=tmp; tmp=s21; s21=rotl64(t,55); t=tmp;
        tmp=s24; s24=rotl64(t, 2); t=tmp; tmp=s04; s04=rotl64(t,14); t=tmp;
        tmp=s15; s15=rotl64(t,27); t=tmp; tmp=s23; s23=rotl64(t,41); t=tmp;
        tmp=s19; s19=rotl64(t,56); t=tmp; tmp=s13; s13=rotl64(t, 8); t=tmp;
        tmp=s12; s12=rotl64(t,25); t=tmp; tmp=s02; s02=rotl64(t,43); t=tmp;
        tmp=s20; s20=rotl64(t,62); t=tmp; tmp=s14; s14=rotl64(t,18); t=tmp;
        tmp=s22; s22=rotl64(t,39); t=tmp; tmp=s09; s09=rotl64(t,61); t=tmp;
        tmp=s06; s06=rotl64(t,20); t=tmp; s01=rotl64(t,44);

        CHI(s00,s01,s02,s03,s04); CHI(s05,s06,s07,s08,s09);
        CHI(s10,s11,s12,s13,s14); CHI(s15,s16,s17,s18,s19);
        CHI(s20,s21,s22,s23,s24);

        s00 ^= RC[r];
    }

    // ── Compare hash < target ──
    uint64_t h, tgt;
    h = bswap64(s00); tgt = params->target_be[0];
    if (h > tgt) return; if (h < tgt) goto found;
    h = bswap64(s01); tgt = params->target_be[1];
    if (h > tgt) return; if (h < tgt) goto found;
    h = bswap64(s02); tgt = params->target_be[2];
    if (h > tgt) return; if (h < tgt) goto found;
    h = bswap64(s03); tgt = params->target_be[3];
    if (h > tgt) return; if (h < tgt) goto found;
    return;

found:
    if (atomicCAS(&result->found[addr_idx], 0u, 1u) == 0u) {
        result->nonce[addr_idx] = nonce;
    }
}

// ── Host code ──

static int hex2byte(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char* hex, uint8_t* out, int len) {
    if (hex[0] == '0' && hex[1] == 'x') hex += 2;
    for (int i = 0; i < len; i++) {
        int hi = hex2byte(hex[i*2]);
        int lo = hex2byte(hex[i*2+1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (hi << 4) | lo;
    }
    return 0;
}

// Check if stdin has data available (non-blocking)
static bool stdin_has_data() {
    fd_set fds;
    struct timeval tv = {0, 0};  // 0 timeout = non-blocking
    FD_ZERO(&fds);
    FD_SET(STDIN_FILENO, &fds);
    return select(STDIN_FILENO + 1, &fds, nullptr, nullptr, &tv) > 0;
}

// Parse a challenge line into components. Returns number of addresses parsed, or -1 on error.
static int parse_challenge_line(const char* line,
                                uint8_t challenge[32], uint8_t target[32],
                                uint8_t addresses[][20], int weights[], int max_addrs) {
    // Tokenize the line (copy it since strtok modifies)
    char buf[MAX_LINE];
    strncpy(buf, line, MAX_LINE - 1);
    buf[MAX_LINE - 1] = '\0';

    char* tokens[MAX_ADDRS + 10];  // challenge + target + up to MAX_ADDRS * 2 (weight + addr)
    int ntokens = 0;
    char* tok = strtok(buf, " \t\r\n");
    while (tok && ntokens < (int)(sizeof(tokens)/sizeof(tokens[0]))) {
        tokens[ntokens++] = tok;
        tok = strtok(nullptr, " \t\r\n");
    }

    if (ntokens < 3) return -1;  // Need at least challenge + target + 1 addr

    if (parse_hex(tokens[0], challenge, 32) < 0) return -1;
    if (parse_hex(tokens[1], target, 32) < 0) return -1;

    int num_addrs = 0;
    int next_weight = 1;
    for (int i = 2; i < ntokens && num_addrs < max_addrs; i++) {
        if (tokens[i][0] == 'W' || tokens[i][0] == 'w') {
            next_weight = atoi(tokens[i] + 1);
            if (next_weight < 1) next_weight = 1;
            if (next_weight > 4) next_weight = 4;
            continue;
        }
        if (parse_hex(tokens[i], addresses[num_addrs], 20) < 0) return -1;
        weights[num_addrs] = next_weight;
        next_weight = 1;
        num_addrs++;
    }
    return num_addrs;
}

// Compute pre-absorbed keccak state for each address
static void compute_pre_states(uint64_t pre_states[][25], const uint8_t challenge[32],
                                const uint8_t addresses[][20], int num_addrs) {
    for (int a = 0; a < num_addrs; a++) {
        uint8_t input[136] = {0};
        memcpy(input, challenge, 32);
        memcpy(input + 32, addresses[a], 20);
        input[84] = 0x01;
        input[135] = 0x80;

        memset(pre_states[a], 0, sizeof(uint64_t) * 25);
        for (int i = 0; i < 17; i++) {
            uint64_t w = 0;
            for (int b = 0; b < 8; b++)
                w |= (uint64_t)input[i*8 + b] << (b * 8);
            pre_states[a][i] = w;
        }
    }
}

// Compute target as big-endian uint64_t[4]
static void compute_target_be(uint64_t target_be[4], const uint8_t target[32]) {
    for (int i = 0; i < 4; i++) {
        uint64_t w = 0;
        for (int b = 0; b < 8; b++)
            w = (w << 8) | target[i*8 + b];
        target_be[i] = w;
    }
}

// Configure dispatch (weighted thread allocation across addresses)
static void configure_dispatch(GrindParams* params, const int weights[], int num_addrs,
                                uint64_t* out_batch_size, int* out_grid_size) {
    const int BLOCK_SIZE = 256;
    const uint64_t RAW_BATCH = 1ULL << 24;  // 16M — faster first-nonce latency (check 16x more often)

    int total_weight = 0;
    for (int a = 0; a < num_addrs; a++) total_weight += weights[a];

    uint64_t batch_size = 0;
    uint32_t cum_offset = 0;
    for (int a = 0; a < num_addrs; a++) {
        uint64_t tpa = (RAW_BATCH * weights[a] / total_weight / BLOCK_SIZE) * BLOCK_SIZE;
        if (tpa < (uint64_t)BLOCK_SIZE) tpa = BLOCK_SIZE;
        params->threads_per_addr[a] = (uint32_t)tpa;
        params->thread_offset[a] = cum_offset;
        cum_offset += (uint32_t)tpa;
        batch_size += tpa;
    }

    *out_batch_size = batch_size;
    *out_grid_size = (int)(batch_size / BLOCK_SIZE);
}

// Run the grind loop. Returns true if completed (found or exhausted), false if aborted.
static bool run_grind(GrindParams* params, GrindResult* result,
                      int num_addrs, uint64_t baseNonce,
                      uint64_t BATCH_SIZE, int GRID_SIZE, int BLOCK_SIZE,
                      bool check_abort) {
    const int MAX_BATCHES = 1 << 20;
    bool found_all[MAX_ADDRS] = {false};
    int found_count = 0;

    auto t0 = std::chrono::steady_clock::now();
    uint64_t totalAttempts = 0;

    for (int batch = 0; batch < MAX_BATCHES && found_count < num_addrs; batch++) {
        params->start_nonce = baseNonce + (uint64_t)batch * BATCH_SIZE;

        // Reset unfound addresses
        for (int a = 0; a < num_addrs; a++) {
            if (!found_all[a]) {
                result->found[a] = 0;
                result->nonce[a] = 0;
            }
        }

        grind_kernel<<<GRID_SIZE, BLOCK_SIZE>>>(params, result);
        cudaDeviceSynchronize();

        totalAttempts += BATCH_SIZE;

        // Check for newly found nonces — stream to stdout immediately
        for (int a = 0; a < num_addrs; a++) {
            if (!found_all[a] && result->found[a]) {
                auto t1 = std::chrono::steady_clock::now();
                double elapsed = std::chrono::duration<double>(t1 - t0).count();
                printf("F %d %llu %.3f\n", a,
                       (unsigned long long)result->nonce[a], elapsed);
                fflush(stdout);
                found_all[a] = true;
                found_count++;
            }
        }

        // Check CUDA errors
        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            fprintf(stderr, "CUDA error: %s\n", cudaGetErrorString(err));
            cudaDeviceReset();
            auto t1 = std::chrono::steady_clock::now();
            double elapsed = std::chrono::duration<double>(t1 - t0).count();
            printf("D %llu %.3f\n", (unsigned long long)totalAttempts, elapsed);
            fflush(stdout);
            return false;
        }

        // In daemon mode, check for ABORT / EOF / signal between batches
        if (check_abort) {
            // Check for fatal signal (SIGHUP from SSH death, SIGTERM, etc.)
            if (got_signal) {
                cudaDeviceSynchronize();
                auto t1 = std::chrono::steady_clock::now();
                double elapsed = std::chrono::duration<double>(t1 - t0).count();
                printf("D %llu %.3f\n", (unsigned long long)totalAttempts, elapsed);
                fflush(stdout);
                return false;  // Signal received — exit grind
            }
            if (stdin_has_data()) {
                char abort_buf[MAX_LINE];
                if (fgets(abort_buf, sizeof(abort_buf), stdin)) {
                    // Trim
                    char* p = abort_buf;
                    while (*p == ' ' || *p == '\t') p++;
                    if (strncmp(p, "ABORT", 5) == 0) {
                        cudaDeviceSynchronize();
                        auto t1 = std::chrono::steady_clock::now();
                        double elapsed = std::chrono::duration<double>(t1 - t0).count();
                        printf("D %llu %.3f\n", (unsigned long long)totalAttempts, elapsed);
                        fflush(stdout);
                        return false;  // Aborted
                    }
                } else {
                    // fgets returned NULL = EOF (SSH connection died)
                    cudaDeviceSynchronize();
                    auto t1 = std::chrono::steady_clock::now();
                    double elapsed = std::chrono::duration<double>(t1 - t0).count();
                    printf("D %llu %.3f\n", (unsigned long long)totalAttempts, elapsed);
                    fflush(stdout);
                    return false;  // EOF — exit immediately
                }
            }
        }
    }

    auto t1 = std::chrono::steady_clock::now();
    double elapsed = std::chrono::duration<double>(t1 - t0).count();
    printf("D %llu %.3f\n", (unsigned long long)totalAttempts, elapsed);
    fflush(stdout);
    return true;
}

// Signal handler — sets flag so grind loop exits quickly
static void signal_handler(int sig) {
    // Write signal info to stderr (async-signal-safe)
    const char* name = "UNKNOWN";
    switch(sig) {
        case SIGTERM: name = "SIGTERM"; break;
        case SIGINT: name = "SIGINT"; break;
        case SIGPIPE: name = "SIGPIPE"; break;
        case SIGHUP: name = "SIGHUP"; break;
        case SIGUSR1: name = "SIGUSR1"; break;
        case SIGUSR2: name = "SIGUSR2"; break;
    }
    fprintf(stderr, "SIGNAL %d (%s) received\n", sig, name);
    fflush(stderr);
    got_signal = sig;
    // Re-raise to get default behavior
    signal(sig, SIG_DFL);
    raise(sig);
}

// ── Daemon mode: persistent CUDA process ──
static int run_daemon() {
    const int BLOCK_SIZE = 256;

    // Allocate unified memory ONCE
    GrindParams* params;
    GrindResult* result;
    cudaMallocManaged(&params, sizeof(GrindParams));
    cudaMallocManaged(&result, sizeof(GrindResult));

    srand((unsigned)time(nullptr) ^ (unsigned)getpid());

    // Warmup: launch a tiny kernel to initialize CUDA context fully
    params->num_addrs = 0;
    params->start_nonce = 0;
    grind_kernel<<<1, 1>>>(params, result);
    cudaDeviceSynchronize();

    // Ignore SIGPIPE (critical for daemon writing to SSH channel)
    signal(SIGPIPE, SIG_IGN);
    // Install signal handlers for debugging other signals
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    signal(SIGHUP, signal_handler);
    signal(SIGUSR1, signal_handler);
    signal(SIGUSR2, signal_handler);
    signal(SIGSEGV, signal_handler);
    signal(SIGABRT, signal_handler);

    fprintf(stderr, "CUDA daemon ready (pid=%d)\n", getpid());
    printf("READY\n");
    fflush(stdout);

    // Main loop: read challenges from stdin
    char line[MAX_LINE];
    while (!got_signal && fgets(line, sizeof(line), stdin)) {
        // Trim leading whitespace
        char* p = line;
        while (*p == ' ' || *p == '\t') p++;

        // Skip empty lines
        if (*p == '\n' || *p == '\r' || *p == '\0') continue;

        // Ignore stray ABORT between challenges
        if (strncmp(p, "ABORT", 5) == 0) continue;

        // Parse challenge line
        uint8_t challenge[32], target[32];
        uint8_t addresses[MAX_ADDRS][20];
        int weights[MAX_ADDRS];

        int num_addrs = parse_challenge_line(p, challenge, target, addresses, weights, MAX_ADDRS);
        if (num_addrs <= 0) {
            fprintf(stderr, "Invalid challenge line, skipping\n");
            printf("READY\n");
            fflush(stdout);
            continue;
        }

        // Compute pre-states
        uint64_t pre_states[MAX_ADDRS][25];
        compute_pre_states(pre_states, challenge, addresses, num_addrs);

        uint64_t target_be[4];
        compute_target_be(target_be, target);

        // Load into GPU params
        memcpy(params->pre_state, pre_states, sizeof(pre_states));
        memcpy(params->target_be, target_be, sizeof(target_be));
        params->num_addrs = num_addrs;

        // Configure dispatch
        uint64_t BATCH_SIZE;
        int GRID_SIZE;
        configure_dispatch(params, weights, num_addrs, &BATCH_SIZE, &GRID_SIZE);

        // Random base nonce per challenge
        uint64_t baseNonce = ((uint64_t)rand() << 32) | (uint64_t)rand();

        // Run grind (with abort checking)
        run_grind(params, result, num_addrs, baseNonce, BATCH_SIZE, GRID_SIZE, BLOCK_SIZE, true);

        // Signal ready for next challenge
        printf("READY\n");
        fflush(stdout);
    }

    cudaFree(params);
    cudaFree(result);
    return 0;
}

// ── One-shot mode (original behavior) ──
static int run_oneshot(int argc, char* argv[]) {
    const int BLOCK_SIZE = 256;

    uint8_t challenge[32], target[32];
    if (parse_hex(argv[1], challenge, 32) < 0 || parse_hex(argv[2], target, 32) < 0) {
        fprintf(stderr, "Invalid hex input\n");
        return 1;
    }

    int num_addrs = 0;
    uint8_t addresses[MAX_ADDRS][20];
    int weights[MAX_ADDRS];
    int next_weight = 1;

    for (int i = 3; i < argc && num_addrs < MAX_ADDRS; i++) {
        if (argv[i][0] == 'W' || argv[i][0] == 'w') {
            next_weight = atoi(argv[i] + 1);
            if (next_weight < 1) next_weight = 1;
            if (next_weight > 4) next_weight = 4;
            continue;
        }
        if (parse_hex(argv[i], addresses[num_addrs], 20) < 0) {
            fprintf(stderr, "Invalid address hex: %s\n", argv[i]);
            return 1;
        }
        weights[num_addrs] = next_weight;
        next_weight = 1;
        num_addrs++;
    }

    // Pre-absorb state
    uint64_t pre_states[MAX_ADDRS][25];
    compute_pre_states(pre_states, challenge, addresses, num_addrs);

    uint64_t target_be[4];
    compute_target_be(target_be, target);

    // Allocate unified memory
    GrindParams* params;
    GrindResult* result;
    cudaMallocManaged(&params, sizeof(GrindParams));
    cudaMallocManaged(&result, sizeof(GrindResult));

    memcpy(params->pre_state, pre_states, sizeof(pre_states));
    memcpy(params->target_be, target_be, sizeof(target_be));
    params->num_addrs = num_addrs;

    srand((unsigned)time(nullptr) ^ (unsigned)getpid());
    uint64_t baseNonce = ((uint64_t)rand() << 32) | (uint64_t)rand();

    // Configure dispatch
    uint64_t BATCH_SIZE;
    int GRID_SIZE;
    configure_dispatch(params, weights, num_addrs, &BATCH_SIZE, &GRID_SIZE);

    // Run grind (no abort checking in one-shot mode)
    bool found = run_grind(params, result, num_addrs, baseNonce, BATCH_SIZE, GRID_SIZE, BLOCK_SIZE, false);

    cudaFree(params);
    cudaFree(result);
    return found ? 0 : 1;
}

int main(int argc, char* argv[]) {
    // Check for --daemon flag
    if (argc == 2 && strcmp(argv[1], "--daemon") == 0) {
        return run_daemon();
    }

    // One-shot mode (backwards compatible)
    if (argc < 4) {
        fprintf(stderr, "Usage: %s <challenge_hex> <target_hex> [W<weight>] <addr1_hex> ...\n", argv[0]);
        fprintf(stderr, "       %s --daemon\n", argv[0]);
        return 1;
    }

    return run_oneshot(argc, argv);
}
