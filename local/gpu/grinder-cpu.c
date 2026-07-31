/*
 * APoW PoW Nonce Grinder — Multi-threaded keccak256
 * Usage: ./grinder <challenge_hex> <address_hex> <target_hex> [threads]
 * Output: <nonce_decimal> <attempts>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <pthread.h>
#include <time.h>

/* ─── Keccak-256 (compact implementation) ──────────────────── */

#define KECCAK_ROUNDS 24

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

static const int ROTC[24] = {
    1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44
};

static const int PILN[24] = {
    10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1
};

static inline uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

static void keccak_f1600(uint64_t st[25]) {
    uint64_t bc[5];
    for (int r = 0; r < KECCAK_ROUNDS; r++) {
        // Theta
        for (int i = 0; i < 5; i++)
            bc[i] = st[i] ^ st[i+5] ^ st[i+10] ^ st[i+15] ^ st[i+20];
        for (int i = 0; i < 5; i++) {
            uint64_t t = bc[(i+4)%5] ^ rotl64(bc[(i+1)%5], 1);
            for (int j = 0; j < 25; j += 5) st[j+i] ^= t;
        }
        // Rho + Pi
        uint64_t t = st[1];
        for (int i = 0; i < 24; i++) {
            int j = PILN[i];
            uint64_t tmp = st[j];
            st[j] = rotl64(t, ROTC[i]);
            t = tmp;
        }
        // Chi
        for (int j = 0; j < 25; j += 5) {
            uint64_t tmp[5];
            for (int i = 0; i < 5; i++) tmp[i] = st[j+i];
            for (int i = 0; i < 5; i++)
                st[j+i] = tmp[i] ^ ((~tmp[(i+1)%5]) & tmp[(i+2)%5]);
        }
        // Iota
        st[0] ^= RC[r];
    }
}

static void keccak256(const uint8_t *in, size_t inlen, uint8_t *out) {
    uint64_t st[25] = {0};
    const int rate = 136; // (1600 - 256*2) / 8

    // Absorb
    while (inlen >= (size_t)rate) {
        for (int i = 0; i < rate/8; i++)
            st[i] ^= ((const uint64_t*)in)[i];
        keccak_f1600(st);
        in += rate;
        inlen -= rate;
    }

    // Final block (pad with aligned copy)
    uint8_t tmp[136] = {0};
    memcpy(tmp, in, inlen);
    tmp[inlen] = 0x01;        // Keccak padding (NOT SHA3 which uses 0x06)
    tmp[rate - 1] |= 0x80;

    for (int i = 0; i < rate/8; i++)
        st[i] ^= ((uint64_t*)tmp)[i];
    keccak_f1600(st);

    // Squeeze (32 bytes)
    memcpy(out, st, 32);
}

/* ─── Hex parsing ──────────────────────────────────────────── */

static int hex2byte(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char *hex, uint8_t *out, int len) {
    if (hex[0] == '0' && hex[1] == 'x') hex += 2;
    for (int i = 0; i < len; i++) {
        int hi = hex2byte(hex[i*2]);
        int lo = hex2byte(hex[i*2+1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (hi << 4) | lo;
    }
    return 0;
}

/* ─── Worker thread ────────────────────────────────────────── */

typedef struct {
    uint8_t base[84];      // challenge(32) + address(20) + nonce_template(32)
    uint8_t target[32];
    uint64_t start;
    uint64_t range;
    uint64_t found_nonce;
    volatile int *global_found;
    uint64_t attempts;
} WorkerArgs;

static void *grind_worker(void *arg) {
    WorkerArgs *a = (WorkerArgs *)arg;
    uint8_t buf[84];
    uint8_t hash[32];
    memcpy(buf, a->base, 52); // challenge + address
    memset(buf + 52, 0, 24);  // Zero first 24 bytes of nonce area

    for (uint64_t n = a->start; n < a->start + a->range; n++) {
        if (*a->global_found) return NULL;

        // Write nonce as big-endian in last 8 bytes (buf[76..83])
        buf[76] = (n >> 56) & 0xff;
        buf[77] = (n >> 48) & 0xff;
        buf[78] = (n >> 40) & 0xff;
        buf[79] = (n >> 32) & 0xff;
        buf[80] = (n >> 24) & 0xff;
        buf[81] = (n >> 16) & 0xff;
        buf[82] = (n >> 8)  & 0xff;
        buf[83] = n & 0xff;

        keccak256(buf, 84, hash);

        // Compare hash < target (MSB first)
        int less = 0;
        for (int i = 0; i < 32; i++) {
            if (hash[i] < a->target[i]) { less = 1; break; }
            if (hash[i] > a->target[i]) break;
        }

        if (less) {
            a->found_nonce = n;
            a->attempts = n - a->start + 1;
            __sync_val_compare_and_swap(a->global_found, 0, 1);
            return NULL;
        }
    }
    a->attempts = a->range;
    return NULL;
}

/* ─── Main ─────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    if (argc < 4) {
        fprintf(stderr, "Usage: %s <challenge_hex> <address_hex> <target_hex> [threads]\n", argv[0]);
        return 1;
    }

    uint8_t challenge[32], address[20], target[32];
    if (parse_hex(argv[1], challenge, 32) < 0 ||
        parse_hex(argv[2], address, 20) < 0 ||
        parse_hex(argv[3], target, 32) < 0) {
        fprintf(stderr, "Invalid hex input\n");
        return 1;
    }

    int nthreads = argc > 4 ? atoi(argv[4]) : 8;
    if (nthreads < 1) nthreads = 1;
    if (nthreads > 64) nthreads = 64;

    // Build base buffer
    uint8_t base[84] = {0};
    memcpy(base, challenge, 32);
    memcpy(base + 32, address, 20);

    // Random start nonce
    srand((unsigned)time(NULL) ^ (unsigned)getpid());
    uint64_t start = ((uint64_t)rand() << 32) | rand();
    uint64_t range_per_thread = 500000000ULL; // 500M per thread max

    volatile int found = 0;
    pthread_t threads[64];
    WorkerArgs args[64];

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (int i = 0; i < nthreads; i++) {
        args[i] = (WorkerArgs){
            .start = start + i * range_per_thread,
            .range = range_per_thread,
            .found_nonce = 0,
            .global_found = &found,
            .attempts = 0
        };
        memcpy(args[i].base, base, 84);
        memcpy(args[i].target, target, 32);
        pthread_create(&threads[i], NULL, grind_worker, &args[i]);
    }

    // Wait for completion
    for (int i = 0; i < nthreads; i++)
        pthread_join(threads[i], NULL);

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;

    // Find the winning thread
    uint64_t total_attempts = 0;
    for (int i = 0; i < nthreads; i++) {
        total_attempts += args[i].attempts;
        if (args[i].found_nonce && found) {
            printf("%llu %llu %.3f\n", args[i].found_nonce, total_attempts, elapsed);
            fflush(stdout);
            return 0;
        }
    }

    fprintf(stderr, "No nonce found after %llu attempts (%.1fs)\n", total_attempts, elapsed);
    return 1;
}
