import dotenv from 'dotenv';
import { getFctMintRate } from '@0xfacet/sdk/utils';


dotenv.config();

function argOf(name) {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (idx === -1) return undefined;
  const tok = process.argv[idx];
  if (tok.includes('=')) return tok.split('=')[1];
  return process.argv[idx + 1];
}

async function getEthUsd() {
  try {
    const r = await fetch('https://eth-price.facet.org');
    const j = await r.json();
    const p = Number(j?.priceInUSD);
    if (isFinite(p) && p > 0) return p;
  } catch {}
  return 3500;
}

async function main() {
  const network = (process.env.NETWORK||'mainnet').toLowerCase(); const l1ChainId = network==='mainnet'? 1 : 11155111; const rateBn = BigInt(await getFctMintRate(l1ChainId)); // FCT-wei per ETH-wei
  if (rateBn <= 0n) throw new Error('invalid mintRate');
  // ETH per FCT = (ETH-wei per FCT-wei) = 1 / rateBn
  const ethPerFct = 1 / Number(rateBn);
  const ethNeededBest = targetFct * ethPerFct; // 忽略固定开销的理想消耗

  // 固定开销比例近似：payloadBytes*40 vs 21k，支持 --kb 或 --bytes
  let nominalBytes = 0;
  if (bytesArg != null && Number(bytesArg) >= 0) {
    nominalBytes = Math.max(0, Math.floor(Number(bytesArg)));
  } else if (kb != null && isFinite(kb) && kb >= 0) {
    nominalBytes = Math.max(0, Math.floor(kb * 1024));
  }
  let factor = isFinite(mult) && mult > 0 ? mult : 1;
  let dataGas = 0;
  if (nominalBytes > 0) {
    const payload = Math.max(0, nominalBytes - 160);
    dataGas = payload * 40; // 近似按非零字节计算
    if (dataGas > 0) factor = factor * (1 + 21000 / dataGas);
  } else {
    // 默认按 25KB 情景估算（dataGas≈1,017,600）
    factor = factor * (1 + 21000 / 1017600);
  }
  const ethNeededAdj = ethNeededBest * factor;

  const ethUsd = await getEthUsd();
  const out = {
    network: process.env.NETWORK || 'mainnet',
    target_fct: targetFct,
    rate_fct_per_eth_wei: rateBn.toString(),
    eth_per_fct_best: ethPerFct,
    kb: kb ?? null,
    bytes: nominalBytes || null,
    data_gas: dataGas || null,
    multiplier: isFinite(mult) && mult > 0 ? mult : 1,
    factor,
    eth_needed_best: ethNeededBest,
    usdt_needed_best: ethNeededBest * ethUsd,
    eth_needed_adjusted: ethNeededAdj,
    usdt_needed_adjusted: ethNeededAdj * ethUsd,
  };
  console.log(JSON.stringify(out));
  console.log(`按最佳情景：约 ${ethNeededBest.toFixed(6)} ETH（≈$${(ethNeededBest*ethUsd).toFixed(2)}）`);
  if (nominalBytes > 0) {
    console.log(`按 ${kb ?? (nominalBytes/1024)} KB + 乘数=${(isFinite(mult)&&mult>0?mult:1)}：约 ${ethNeededAdj.toFixed(6)} ETH（≈$${(ethNeededAdj*ethUsd).toFixed(2)}）`);
  } else {
    console.log(`按 25KB + 乘数=${(isFinite(mult)&&mult>0?mult:1)}：约 ${ethNeededAdj.toFixed(6)} ETH（≈$${(ethNeededAdj*ethUsd).toFixed(2)}）`);
  }
}

main().catch(e=>{ console.error('[ERROR] estimate failed', e); process.exit(1); });

