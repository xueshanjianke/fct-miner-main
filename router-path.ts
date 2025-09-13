#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, http, parseAbi, parseAbiItem, decodeFunctionData, getAddress } from 'viem';
import { getNetworkConfig } from './config';

dotenv.config();

function mask(a: string) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : a; }

async function main() {
  const net = getNetworkConfig();
  const rpc = process.env.RPC_URL || net.facetRpcUrl;
  const pc = createPublicClient({ chain: net.facetChain, transport: http(rpc) });

  const pair = getAddress(process.env.PAIR as `0x${string}`);
  const lookback = Number(process.env.LOOKBACK_BLOCKS || 100_000);
  const latest = await pc.getBlockNumber();
  const fromBlock = latest > BigInt(lookback) ? latest - BigInt(lookback) : 0n;

  // Grab recent Swap logs from the pair
  const swapEvent = parseAbiItem('event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)');
  const logs = await pc.getLogs({ address: pair, event: swapEvent, fromBlock, toBlock: latest });
  if (!logs.length) {
    console.log(JSON.stringify({ ok: false, reason: 'no_swap_logs' }));
    return;
  }
  // Pick the most recent one
  const last = logs[logs.length - 1];
  const txHash = last.transactionHash!;
  const tx = await pc.getTransaction({ hash: txHash });
  const to = tx.to as `0x${string}` | null;
  const input = tx.input as `0x${string}`;

  // Try decode against common router fn signatures that include path
  const ABIS = parseAbi([
    'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    'function swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
    'function swapExactETHForTokens(uint256,address[],address,uint256)'
  ]);

  let decoded: { functionName: string; args: any[] } | undefined;
  try {
    decoded = decodeFunctionData({ abi: ABIS, data: input });
  } catch {}

  let path: string[] | undefined;
  if (decoded) {
    const fn = decoded.functionName;
    const args = decoded.args as any[];
    if (fn === 'swapExactETHForTokens') {
      path = (args?.[1] as string[] | undefined) || undefined;
    } else {
      path = (args?.[2] as string[] | undefined) || undefined;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    tx: txHash,
    router: to ? getAddress(to) : null,
    function: decoded?.functionName,
    path: path?.map(getAddress),
    masked_path: path?.map(mask),
  }));
}

main().catch((e) => { console.error('[ERROR] router-path', e); process.exit(1); });

