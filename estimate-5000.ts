import * as dotenv from 'dotenv';
import { getFctMintRate } from '@0xfacet/sdk/utils';
import { getNetworkConfig } from './config';

dotenv.config();

async function main() {
  const net = getNetworkConfig();
  const rate = await getFctMintRate(net.l1Chain.id);
  const rateBn = BigInt(rate as any);
  if (rateBn <= 0n) throw new Error('Invalid mint rate');
  const ethPerFctWei = (10n ** 18n) * (10n ** 18n) / rateBn;
  const ethPerFct = Number(ethPerFctWei) / 1e18 / 1e18;

  const targetFct = 5000;
  const ethNeeded = ethPerFct * targetFct;

  const mult = Number(process.env.GAS_PRICE_MULTIPLIER || '1.0');
  const overheadRatio = 21000 / 1017600; // 25KB 情景 ~2.06%
  const factor = (isFinite(mult) && mult > 0 ? mult : 1) * (1 + overheadRatio);
  const ethNeeded25kb = ethNeeded * factor;

  let ethUsd = 3500;
  try {
    const r = await fetch('https://eth-price.facet.org');
    const j = await r.json();
    const p = Number(j?.priceInUSD);
    if (isFinite(p) && p > 0) ethUsd = p;
  } catch {}

  const usdtBest = ethNeeded * ethUsd;
  const usdt25kb = ethNeeded25kb * ethUsd;

  const out = {
    network: process.env.NETWORK || 'mainnet',
    rate_fct_per_eth_wei: rateBn.toString(),
    eth_per_fct_best: ethPerFct.toFixed(12),
    target_fct: targetFct,
    eth_needed_best: ethNeeded.toFixed(6),
    usdt_needed_best: usdtBest.toFixed(2),
    eth_needed_25kb_with_multiplier: ethNeeded25kb.toFixed(6),
    usdt_needed_25kb_with_multiplier: usdt25kb.toFixed(2),
    multiplier: mult,
  };
  console.log(JSON.stringify(out));
  console.log(`按最佳情景（大负载、乘数=1.0）：约 ${ethNeeded.toFixed(6)} ETH（≈$${usdtBest.toFixed(2)}）`);
  console.log(`按 25KB + 乘数=${mult} 估算：约 ${ethNeeded25kb.toFixed(6)} ETH（≈$${usdt25kb.toFixed(2)}）`);
}

main().catch((e)=>{ console.error('[ERROR] estimate failed', e); process.exit(1); });

