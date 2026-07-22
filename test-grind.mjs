import fs from 'fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

const content = fs.readFileSync('/Users/aklo/mining/wallet-0x4A3F71CF0D4750b67e25Ae7Ef7e38720b3D6e26a.txt', 'utf8');
const pk = content.split('\n').find(l => l.includes('Private Key:')).split('Private Key:')[1].trim();
const signer = privateKeyToAccount(pk);
console.log('Wallet:', signer.address);

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  throw new Error('RPC_URL is required; refusing to use public Base RPC endpoints');
}
const pub = createPublicClient({ chain: base, transport: http(RPC_URL) });
const [challenge, target] = await pub.readContract({
  address: '0x12577CF0D8a07363224D6909c54C056A183e13b3',
  abi: parseAbi(['function getMiningChallenge() view returns (bytes32, uint256, (uint256, uint256, uint256, uint256, uint256, uint256))']),
  functionName: 'getMiningChallenge',
});

console.log('Challenge:', challenge);
console.log('Target:', '0x' + target.toString(16).padStart(64, '0'));

const usdcBal = await pub.readContract({
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
  functionName: 'balanceOf',
  args: [signer.address],
});
console.log('USDC balance:', Number(usdcBal) / 1e6);

// Step 1: raw fetch to get 402 + payment requirements
console.log('\n--- Step 1: Get payment requirements ---');
const grindBody = JSON.stringify({ challenge, target: target.toString(), address: signer.address });
const raw402 = await fetch('https://grind.apow.io/grind', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: grindBody,
});
console.log('Status:', raw402.status);
const payHeader = raw402.headers.get('payment-required');
if (!payHeader) {
  console.log('ERROR: No payment-required header!');
  console.log('Headers:', Object.fromEntries(raw402.headers));
  process.exit(1);
}
const payReq = JSON.parse(Buffer.from(payHeader, 'base64').toString());
console.log('x402 version:', payReq.x402Version);
console.log('Amount:', payReq.accepts?.[0]?.amount, '($' + (Number(payReq.accepts?.[0]?.amount || 0) / 1e6) + ')');
console.log('Network:', payReq.accepts?.[0]?.network);
console.log('PayTo:', payReq.accepts?.[0]?.payTo);

// Step 2: Use x402 client to create payment
console.log('\n--- Step 2: Create payment ---');
const client = new x402Client();
registerExactEvmScheme(client, { signer });

try {
  const paymentHeader = await client.createPayment(payReq.accepts[0]);
  console.log('Payment created, header length:', paymentHeader?.length || 0);
  console.log('Payment header (first 80 chars):', paymentHeader?.slice(0, 80));

  // Step 3: Manual retry with payment
  console.log('\n--- Step 3: Retry with payment ---');
  const start = Date.now();
  const resp = await fetch('https://grind.apow.io/grind', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT': paymentHeader,
    },
    body: grindBody,
    signal: AbortSignal.timeout(180_000), // 3 min to handle cold start
  });

  const elapsed = (Date.now() - start) / 1000;
  const text = await resp.text();

  console.log('\n=== RESULT ===');
  console.log('HTTP:', resp.status);
  console.log('Time:', elapsed.toFixed(2) + 's');
  console.log('Body:', text.slice(0, 500));
  console.log('Queue:', resp.headers.get('x-grind-queue-time'));
  console.log('Compute:', resp.headers.get('x-grind-compute-time'));

  try {
    const data = JSON.parse(text);
    if (data.nonce) {
      console.log('\n>>> SUCCESS — Nonce:', data.nonce, '| GPU time:', data.elapsed + 's');
    }
  } catch {}
} catch (e) {
  console.error('Payment ERROR:', e.message, e.stack?.split('\n').slice(0, 3).join('\n'));
}
