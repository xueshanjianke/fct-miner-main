#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, http, parseAbiItem, getAddress } from 'viem';
import { getNetworkConfig } from './config';

dotenv.config();

function mask(addr: string) { return addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr; }

async function main() {
  const net = getNetworkConfig();
  const rpc = process.env.RPC_URL || net.facetRpcUrl;
  const pair = getAddress((process.env.PAIR as `0x${string}`));
  const lookback = Number(process.env.LOOKBACK_BLOCKS || 100_000);
  const maxOut = Number(process.env.MAX_CANDIDATES || 10);

  const pc = createPublicClient({ chain: net.facetChain, transport: http(rpc) });
  const latest = await pc.getBlockNumber();
  const fromBlock = latest > BigInt(lookback) ? (latest - BigInt(lookback)) : 0n;

  const swapEvent = parseAbiItem('event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)');

  const logs = await pc.getLogs({ address: pair, event: swapEvent, fromBlock, toBlock: latest });
  const counts = new Map<string, number>();
  for (const l of logs) {
    const sender = (l.args?.sender as string | undefined) || '';
    if (!sender) continue;
    const s = getAddress(sender);
    counts.set(s, (counts.get(s) || 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a,b) => b[1]-a[1]).slice(0, maxOut);
  const out = ranked.map(([addr, cnt]) => ({ router_candidate: addr, masked: mask(addr), swaps: cnt }));
  console.log(JSON.stringify({ pair: getAddress(pair), fromBlock: fromBlock.toString(), toBlock: latest.toString(), candidates: out }));
}

main().catch((e) => { console.error('[ERROR] find-router-from-pair', e); process.exit(1); });

