#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, http, parseAbi, decodeFunctionData, getAddress } from 'viem';
import { getNetworkConfig } from './config';

dotenv.config();

function mask(a: string) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : a; }

async function main() {
  const txHash = (process.argv[2] as `0x${string}` | undefined);
  if (!txHash) {
    console.error('Usage: pnpm -s tx:decode 0x<tx_hash>');
    process.exit(1);
  }

  const net = getNetworkConfig();
  const rpc = process.env.RPC_URL || net.facetRpcUrl;
  const pc = createPublicClient({ chain: net.facetChain, transport: http(rpc) });

  const tx = await pc.getTransaction({ hash: txHash });
  const to = tx.to ? getAddress(tx.to) : null;
  const input = tx.input as `0x${string}`;

  const ABIS = parseAbi([
    'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
    'function swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
    'function swapExactETHForTokens(uint256,address[],address,uint256)'
  ]);

  let decoded: { functionName: string; args: readonly any[] } | undefined;
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
    tx: txHash,
    router: to ? mask(to) : null,
    function: decoded?.functionName,
    path: path?.map(getAddress),
    masked_path: path?.map(mask),
  }));
}

main().catch((e) => { console.error('[ERROR] tx:decode', e); process.exit(1); });

