#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { getNetworkConfig } from './config';
import { getAddresses, getPairInfo, getReserves, mask } from './autotrader/pricing';

dotenv.config();

async function main() {
  const net = getNetworkConfig();
  const rpc = process.env.RPC_URL || net.facetRpcUrl;
  const pc = createPublicClient({ chain: net.facetChain, transport: http(rpc) });

  const { router, pair, fct, weth } = getAddresses();

  // Router views
  const ROUTER_VIEW = parseAbi([
    'function factory() view returns (address)'
  ]);
  // Try a list of common WETH getters on various routers
  const WETH_FN_CANDIDATES = [
    'function WETH() view returns (address)',
    'function WETH9() view returns (address)',
    'function weth() view returns (address)',
    'function WRAPPED_ETH() view returns (address)'
  ] as const;
  // V2 factory
  const FACTORY_ABI = parseAbi([
    'function getPair(address tokenA, address tokenB) view returns (address pair)'
  ]);

  let routerWETH: `0x${string}` | undefined;
  let factory: `0x${string}` | undefined;
  try { factory = await pc.readContract({ address: router, abi: ROUTER_VIEW, functionName: 'factory' }) as `0x${string}`; } catch {}
  if (!routerWETH) {
    for (const sig of WETH_FN_CANDIDATES) {
      try {
        const abi = parseAbi([sig]);
        const fn = (sig.match(/function\s+(\w+)/)?.[1] || 'WETH') as any;
        const res = await pc.readContract({ address: router, abi, functionName: fn });
        if (typeof res === 'string') { routerWETH = getAddress(res as `0x${string}`); break; }
      } catch {}
    }
  }

  // EIP-1967 implementation slot fallback
  let impl: `0x${string}` | undefined;
  try {
    const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const raw = await pc.getStorageAt({ address: router, slot: IMPL_SLOT });
    if (typeof raw === 'string' && raw.length >= 66) {
      const addr = '0x' + raw.slice(-40);
      impl = getAddress(addr as `0x${string}`);
    }
  } catch {}
  let weth_impl: `0x${string}` | undefined;
  if (!routerWETH && impl) {
    for (const sig of WETH_FN_CANDIDATES) {
      try {
        const abi = parseAbi([sig]);
        const fn = (sig.match(/function\s+(\w+)/)?.[1] || 'WETH') as any;
        const res = await pc.readContract({ address: impl, abi, functionName: fn });
        if (typeof res === 'string') { weth_impl = getAddress(res as `0x${string}`); routerWETH = weth_impl; break; }
      } catch {}
    }
  }

  // Try to resolve factory.getPair using routerWETH; if missing, fallback to env WETH
  let factoryPair: `0x${string}` | undefined;
  let factoryPairReversed: `0x${string}` | undefined;
  let factoryPairSorted: `0x${string}` | undefined;
  if (factory) {
    try {
      const wethForQuery = routerWETH ?? weth;
      const a = getAddress(fct);
      const b = getAddress(wethForQuery);
      // direct order
      try { factoryPair = await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPair', args: [a, b] }) as `0x${string}`; } catch {}
      // reversed order
      try { factoryPairReversed = await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPair', args: [b, a] }) as `0x${string}`; } catch {}
      // sorted order
      const [s0, s1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
      try { factoryPairSorted = await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPair', args: [s0, s1] }) as `0x${string}`; } catch {}
    } catch {}
  }

  const info = await getPairInfo().catch(() => undefined);
  const reserves = await getReserves().catch(() => undefined);

  // Also read pair.factory() (from Pair core), if available
  const PAIR_ABI = parseAbi(['function factory() view returns (address)']);
  let pairFactory: `0x${string}` | undefined;
  try {
    pairFactory = await pc.readContract({ address: pair, abi: PAIR_ABI, functionName: 'factory' }) as `0x${string}`;
  } catch {}

  const out = {
    router: mask(router),
    factory: factory ? mask(factory) : undefined,
    weth_env: mask(weth),
    weth_router: routerWETH ? mask(routerWETH) : undefined,
    impl: impl ? mask(impl) : undefined,
    weth_impl: weth_impl ? mask(weth_impl) : undefined,
    pair_env: mask(pair),
    pair_from_factory: factoryPair ? mask(factoryPair) : undefined,
    pair_from_factory_reversed: factoryPairReversed ? mask(factoryPairReversed) : undefined,
    pair_from_factory_sorted: factoryPairSorted ? mask(factoryPairSorted) : undefined,
    pair_matches_factory_any: [factoryPair, factoryPairReversed, factoryPairSorted].filter(Boolean).some(x => getAddress(x as `0x${string}`) === getAddress(pair)),
    pair_factory: pairFactory ? mask(pairFactory) : undefined,
    router_factory_matches_pair_factory: (factory && pairFactory) ? (getAddress(factory) === getAddress(pairFactory)) : undefined,
    pair_token0: info ? mask(info.token0) : undefined,
    pair_token1: info ? mask(info.token1) : undefined,
    reserve0: reserves ? reserves.reserve0.toString() : undefined,
    reserve1: reserves ? reserves.reserve1.toString() : undefined,
  };
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error('[ERROR] router-inspect', e); process.exit(1); });
