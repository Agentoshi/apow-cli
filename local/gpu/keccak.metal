/*
 * Keccak-256 GPU nonce grinder — Apple Metal compute shader
 * Each GPU thread tests one nonce independently.
 */

#include <metal_stdlib>
using namespace metal;

// ── Keccak-256 round constants ──

constant uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

constant int ROTC[24] = {
    1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44
};

constant int PILN[24] = {
    10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1
};

static inline uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

static void keccak_f1600(thread uint64_t st[25]) {
    uint64_t bc[5];
    for (int r = 0; r < 24; r++) {
        for (int i = 0; i < 5; i++)
            bc[i] = st[i] ^ st[i+5] ^ st[i+10] ^ st[i+15] ^ st[i+20];
        for (int i = 0; i < 5; i++) {
            uint64_t t = bc[(i+4)%5] ^ rotl64(bc[(i+1)%5], 1);
            for (int j = 0; j < 25; j += 5) st[j+i] ^= t;
        }
        uint64_t t = st[1];
        for (int i = 0; i < 24; i++) {
            int j = PILN[i];
            uint64_t tmp = st[j];
            st[j] = rotl64(t, ROTC[i]);
            t = tmp;
        }
        for (int j = 0; j < 25; j += 5) {
            uint64_t tmp[5];
            for (int i = 0; i < 5; i++) tmp[i] = st[j+i];
            for (int i = 0; i < 5; i++)
                st[j+i] = tmp[i] ^ ((~tmp[(i+1)%5]) & tmp[(i+2)%5]);
        }
        st[0] ^= RC[r];
    }
}

// ── Input structure (set by host) ──

struct GrindParams {
    // Pre-built 84-byte input: challenge(32) + address(20) + zero_pad(32)
    // We only modify the last 8 bytes (nonce) per thread
    uint8_t base[84];
    uint8_t target[32];
    uint32_t _pad;         // align start_nonce to 8 bytes
    uint64_t start_nonce;
};

// ── Result buffer ──

struct GrindResult {
    atomic_uint found;     // 0 = not found, 1 = found
    uint64_t nonce;        // winning nonce
    uint32_t thread_id;    // which thread found it
};

// ── GPU kernel: each thread tests one nonce ──

kernel void grind_nonce(
    device const GrindParams& params [[buffer(0)]],
    device GrindResult& result [[buffer(1)]],
    uint tid [[thread_position_in_grid]]
) {
    // Early exit if someone already found it
    if (atomic_load_explicit(&result.found, memory_order_relaxed)) return;

    uint64_t nonce = params.start_nonce + tid;

    // Build input: copy base, write nonce big-endian into last 8 bytes
    uint8_t buf[84];
    for (int i = 0; i < 76; i++) buf[i] = params.base[i];
    buf[76] = (nonce >> 56) & 0xff;
    buf[77] = (nonce >> 48) & 0xff;
    buf[78] = (nonce >> 40) & 0xff;
    buf[79] = (nonce >> 32) & 0xff;
    buf[80] = (nonce >> 24) & 0xff;
    buf[81] = (nonce >> 16) & 0xff;
    buf[82] = (nonce >> 8) & 0xff;
    buf[83] = nonce & 0xff;

    // Keccak-256: build padded 136-byte block, absorb, permute
    uint64_t st[25] = {0};

    uint8_t padded[136] = {0};
    for (int i = 0; i < 84; i++) padded[i] = buf[i];
    padded[84] = 0x01;
    padded[135] |= 0x80;

    for (int i = 0; i < 17; i++) {
        uint64_t w = 0;
        for (int b = 0; b < 8; b++)
            w |= uint64_t(padded[i*8 + b]) << (b * 8);
        st[i] ^= w;
    }

    keccak_f1600(st);

    // Extract 32-byte hash
    uint8_t hash[32];
    for (int i = 0; i < 4; i++) {
        for (int b = 0; b < 8; b++)
            hash[i*8 + b] = (st[i] >> (b * 8)) & 0xff;
    }

    // Big-endian comparison: hash < target
    bool less = false;
    for (int i = 0; i < 32; i++) {
        if (hash[i] < params.target[i]) { less = true; break; }
        if (hash[i] > params.target[i]) break;
    }

    if (less) {
        // Atomically claim the result
        uint expected = 0;
        if (atomic_compare_exchange_weak_explicit(&result.found, &expected, 1u,
                memory_order_relaxed, memory_order_relaxed)) {
            result.nonce = nonce;
            result.thread_id = tid;
        }
    }
}
