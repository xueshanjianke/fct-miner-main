#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { calculateInputGasCost } from '@0xfacet/sdk/utils';

dotenv.config();

function argOf(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (idx === -1) return undefined;
  const tok = process.argv[idx];
  if (tok.includes('=')) return tok.split('=')[1];
  return process.argv[idx + 1];
}

async function getBaseFeeGwei(): Promise<number | undefined> {
  const body = { jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', false], id: 1 } as const;
  for (const rpc of ['https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com']) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const hex: string | undefined = j?.result?.baseFeePerGas;
      if (!hex) continue;
      const n = BigInt(hex);
      return Number(n) / 1e9;
    } catch {}
  }
  return undefined;
}

async function main() {
  if ((process.env.NETWORK || '').toLowerCase() !== 'mainnet') {
    console.warn('[WARN] NETWORK != mainnet; suggest: pnpm test:mine:mainnet:dry');
  }
  // 支持 --bytes 与小数 KB（命令行优先于 .env）
  const bytesArg = argOf('--bytes') ?? process.env.TEST_MINE_BYTES;
  const kbArg = argOf('--kb') ?? process.env.TEST_MINE_KB;
  const kbNum = kbArg != null ? Number(kbArg) : undefined; // 允许小数
  const valueEth = Number(process.env.VALUE_ETH || argOf('--value-eth') || '0');
  const gweiMin = process.env.GWEI_MIN ? Number(process.env.GWEI_MIN) : (argOf('--gwei-min') ? Number(argOf('--gwei-min')) : undefined);
  const gweiMax = process.env.GWEI_MAX ? Number(process.env.GWEI_MAX) : (argOf('--gwei-max') ? Number(argOf('--gwei-max')) : undefined);
  const capEth = process.env.CAP_ETH ? Number(process.env.CAP_ETH) : (argOf('--cap-eth') ? Number(argOf('--cap-eth')) : undefined);
  const gasMult = Number(process.env.GAS_PRICE_MULTIPLIER || argOf('--gas-multiplier') || '1.5');

  // 计算名义大小（字节）
  const overheadBytes = 160;
  let nominalBytes: number;
  if (bytesArg != null && Number(bytesArg) >= 0) {
    nominalBytes = Math.max(0, Math.floor(Number(bytesArg)));
  } else if (kbNum != null && isFinite(kbNum) && kbNum >= 0) {
    nominalBytes = Math.max(0, Math.floor(kbNum * 1024));
  } else {
    nominalBytes = 25 * 1024; // 默认 25KB
  }
  const kb = nominalBytes / 1024; // 可能是小数
  const mineBoostSize = Math.max(0, nominalBytes - overheadBytes);
  const baseExecutionGas = 21000n;
  const dataGas = calculateInputGasCost(new Uint8Array(mineBoostSize).fill(70));
  const totalGas = Number(dataGas + baseExecutionGas);

  const baseGwei = await getBaseFeeGwei();
  const gasPriceGwei = baseGwei ? baseGwei * (isFinite(gasMult) && gasMult > 0 ? gasMult : 1) : undefined;
  const feeEth = gasPriceGwei ? (totalGas * (gasPriceGwei / 1e9)) : undefined;
  // 获取 ETH/USD 价格用于友好提示
  let ethUsd = 3500;
  try {
    const r = await fetch('https://eth-price.facet.org');
    const j = await r.json();
    const p = Number(j?.priceInUSD);
    if (isFinite(p) && p > 0) ethUsd = p;
  } catch {}
  const decision: string[] = [];
  if (!isFinite(valueEth) || valueEth <= 0) decision.push('invalid_value');
  if (gasPriceGwei != null && gweiMin != null && gasPriceGwei < gweiMin) decision.push('out_of_gwei_bounds');
  if (gasPriceGwei != null && gweiMax != null && gasPriceGwei > gweiMax) decision.push('out_of_gwei_bounds');
  const totalEstEth = (feeEth ?? 0) + (isFinite(valueEth) ? valueEth : 0);
  if (capEth != null && totalEstEth > capEth) decision.push('over_cap');

  const line = {
    dry_mine: {
      kb,
      calldata_bytes: mineBoostSize,
      data_gas_est: Number(dataGas),
      gas_price_gwei: gasPriceGwei ?? null,
      fee_eth: feeEth != null ? feeEth.toFixed(9) : null,
      value_eth: isFinite(valueEth) ? valueEth.toFixed(9) : null,
      total_est_eth: isFinite(totalEstEth) ? totalEstEth.toFixed(9) : null,
      cap_eth: capEth != null ? capEth.toFixed(9) : undefined,
      decision: decision.length ? `SKIP(${decision.join('+')})` : 'OK',
    },
  } as const;
  console.log(JSON.stringify(line));
  try {
    const feeUsd = feeEth != null ? (feeEth * ethUsd) : undefined;
    const totalUsd = isFinite(totalEstEth) ? (totalEstEth * ethUsd) : undefined;
    console.log(
      `【干跑】KB=${kb} calldata=${mineBoostSize} data_gas≈${Number(dataGas)} gasPrice≈${gasPriceGwei?.toFixed(3) ?? '-'} gwei ` +
      `fee≈${feeEth?.toFixed(9) ?? '-'} ETH${feeUsd!=null?`（≈${feeUsd.toFixed(2)} U）`:''} ` +
      `value=${isFinite(valueEth) ? valueEth.toFixed(9) : '-'} ` +
      `total≈${isFinite(totalEstEth) ? totalEstEth.toFixed(9) : '-'} ETH${totalUsd!=null?`（≈${totalUsd.toFixed(2)} U）`:''} ` +
      `decision=${line.dry_mine.decision}`
    );
  } catch {}
  console.log('DONE');
}

main().catch((e) => { console.error('[ERROR] test:mine:mainnet:dry failed', e); process.exit(1); });
