/*
 * APoW GPU Nonce Grinder — Metal compute on Apple Silicon
 * Usage: ./grinder-gpu <challenge_hex> <address_hex> <target_hex>
 * Output: <nonce_decimal> <attempts> <elapsed_seconds>
 *
 * Dispatches millions of nonces per batch to the GPU.
 * M3 Max (40 GPU cores) should hit 500M-2B+ H/s.
 */

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

// Must match the Metal shader structs exactly (natural alignment)
typedef struct {
    uint8_t base[84];
    uint8_t target[32];
    uint32_t _pad;        // align start_nonce to 8 bytes (84+32=116, +4=120)
    uint64_t start_nonce;
} GrindParams;

typedef struct {
    uint32_t found;       // atomic in shader, plain here
    uint32_t _pad;        // alignment
    uint64_t nonce;
    uint32_t thread_id;
} GrindResult;

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

int main(int argc, char *argv[]) {
    @autoreleasepool {
        if (argc < 4) {
            fprintf(stderr, "Usage: %s <challenge_hex> <address_hex> <target_hex>\n", argv[0]);
            return 1;
        }

        uint8_t challenge[32], address[20], target[32];
        if (parse_hex(argv[1], challenge, 32) < 0 ||
            parse_hex(argv[2], address, 20) < 0 ||
            parse_hex(argv[3], target, 32) < 0) {
            fprintf(stderr, "Invalid hex input\n");
            return 1;
        }

        // ── Metal setup ──
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            fprintf(stderr, "No Metal device found\n");
            return 1;
        }

        // Load shader from .metallib (pre-compiled) or compile from source
        NSError *error = nil;
        NSString *shaderPath = [[[NSString stringWithUTF8String:argv[0]]
            stringByDeletingLastPathComponent]
            stringByAppendingPathComponent:@"keccak.metallib"];

        id<MTLLibrary> library = nil;
        if ([[NSFileManager defaultManager] fileExistsAtPath:shaderPath]) {
            library = [device newLibraryWithFile:shaderPath error:&error];
        }

        if (!library) {
            // Fallback: compile from source
            NSString *srcDir = [[NSString stringWithUTF8String:argv[0]] stringByDeletingLastPathComponent];
            NSString *srcPath = [srcDir stringByAppendingPathComponent:@"keccak.metal"];
            NSString *source = [NSString stringWithContentsOfFile:srcPath encoding:NSUTF8StringEncoding error:&error];
            if (!source) {
                fprintf(stderr, "Cannot read shader: %s\n", [[error localizedDescription] UTF8String]);
                return 1;
            }
            MTLCompileOptions *opts = [[MTLCompileOptions alloc] init];
            opts.fastMathEnabled = YES;
            library = [device newLibraryWithSource:source options:opts error:&error];
            if (!library) {
                fprintf(stderr, "Shader compile error: %s\n", [[error localizedDescription] UTF8String]);
                return 1;
            }
        }

        id<MTLFunction> function = [library newFunctionWithName:@"grind_nonce"];
        if (!function) {
            fprintf(stderr, "Cannot find grind_nonce kernel\n");
            return 1;
        }

        id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:function error:&error];
        if (!pipeline) {
            fprintf(stderr, "Pipeline error: %s\n", [[error localizedDescription] UTF8String]);
            return 1;
        }

        id<MTLCommandQueue> queue = [device newCommandQueue];

        // ── Buffers ──
        id<MTLBuffer> paramsBuf = [device newBufferWithLength:sizeof(GrindParams)
                                                     options:MTLResourceStorageModeShared];
        id<MTLBuffer> resultBuf = [device newBufferWithLength:sizeof(GrindResult)
                                                     options:MTLResourceStorageModeShared];

        GrindParams *params = (GrindParams *)paramsBuf.contents;
        memset(params, 0, sizeof(GrindParams));
        memcpy(params->base, challenge, 32);
        memcpy(params->base + 32, address, 20);
        memcpy(params->target, target, 32);

        // Random start nonce
        srand((unsigned)time(NULL) ^ (unsigned)getpid());
        uint64_t baseNonce = ((uint64_t)rand() << 32) | rand();

        // ── Dispatch config ──
        // Each batch tests BATCH_SIZE nonces on the GPU
        // M3 Max: 40 cores * ~1024 threads/core = ~40k concurrent
        // We dispatch much more to keep the GPU saturated
        const uint64_t BATCH_SIZE = 1 << 24;  // 16M nonces per batch
        const int MAX_BATCHES = 1 << 20;      // ~16T nonces — never exhausts before abort

        NSUInteger threadGroupSize = pipeline.maxTotalThreadsPerThreadgroup;
        if (threadGroupSize > 1024) threadGroupSize = 1024;

        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);

        uint64_t totalAttempts = 0;

        for (int batch = 0; batch < MAX_BATCHES; batch++) {
            params->start_nonce = baseNonce + (uint64_t)batch * BATCH_SIZE;

            // Reset result
            GrindResult *result = (GrindResult *)resultBuf.contents;
            result->found = 0;
            result->nonce = 0;
            result->thread_id = 0;

            // Dispatch
            id<MTLCommandBuffer> cmdBuf = [queue commandBuffer];
            id<MTLComputeCommandEncoder> encoder = [cmdBuf computeCommandEncoder];
            [encoder setComputePipelineState:pipeline];
            [encoder setBuffer:paramsBuf offset:0 atIndex:0];
            [encoder setBuffer:resultBuf offset:0 atIndex:1];

            MTLSize gridSize = MTLSizeMake(BATCH_SIZE, 1, 1);
            MTLSize groupSize = MTLSizeMake(threadGroupSize, 1, 1);
            [encoder dispatchThreads:gridSize threadsPerThreadgroup:groupSize];
            [encoder endEncoding];

            [cmdBuf commit];
            [cmdBuf waitUntilCompleted];

            totalAttempts += BATCH_SIZE;

            // Check result
            result = (GrindResult *)resultBuf.contents;
            if (result->found) {
                clock_gettime(CLOCK_MONOTONIC, &t1);
                double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
                printf("%llu %llu %.3f\n", (unsigned long long)result->nonce,
                       (unsigned long long)totalAttempts, elapsed);
                fflush(stdout);
                return 0;
            }
        }

        clock_gettime(CLOCK_MONOTONIC, &t1);
        double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
        fprintf(stderr, "No nonce found after %llu attempts (%.1fs)\n",
                (unsigned long long)totalAttempts, elapsed);
        return 1;
    }
}
