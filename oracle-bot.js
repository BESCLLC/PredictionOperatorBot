// File: oracle-bot.js
import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: 'json' };
import OracleAbi from './abi/SimpleOracleForPredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  ORACLE_ADDRESS,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  ASSET = 'bitcoin',
  CHECK_INTERVAL = 5000,   // 5s poll loop
  GAS_LIMIT = 200000,
} = process.env;

if (!RPC_URL || !ORACLE_ADDRESS || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, ORACLE_ADDRESS, PREDICTION_ADDRESS, or PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const oracle = new ethers.Contract(ORACLE_ADDRESS, OracleAbi, wallet);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, provider);

function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Price fetcher (Binance.US) ---
async function fetchPrice() {
  const r = await axios.get('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD');
  const price = Number(r.data.price);
  if (!price) throw new Error('Price not found');
  return BigInt(Math.round(price * 1e8)); // scale to 1e8
}

// --- Send oracle update tx ---
async function pushPrice(price, nonceOverride) {
  const opts = {
    gasLimit: GAS_LIMIT,
    gasPrice: ethers.parseUnits('1000', 'gwei'),
  };
  if (nonceOverride !== undefined) opts.nonce = nonceOverride;

  const tx = await oracle.updatePrice(price, opts);
  console.log(`[oracle-bot] 🚀 Oracle update tx sent: ${tx.hash}, price=$${Number(price) / 1e8}`);
  await tx.wait(2);
  console.log(`[oracle-bot] ✅ Oracle price updated on-chain`);
}

// --- Main loop ---
async function loop() {
  try {
    const epoch = Number(await prediction.currentEpoch());
    const round = await prediction.rounds(epoch);
    const buffer = Number(await prediction.bufferSeconds());
    const now = Math.floor(Date.now() / 1000);
    const lockTime = Number(round.lockTimestamp);

    // Log monitoring info
    console.log(
      `[oracle-bot] Monitor: epoch=${epoch}, lock=${ts(lockTime)}, now=${ts(now)}, buffer=${buffer}, oracleCalled=${round.oracleCalled}`
    );

    // Only update inside [lock, lock+buffer]
    if (lockTime > 0 && now >= lockTime && now <= lockTime + buffer) {
      const price = await fetchPrice();

      // Check if already updated this epoch
      const latestId = Number(await prediction.oracleLatestRoundId());
      const [roundId] = await oracle.latestRoundData();
      if (Number(roundId) <= latestId) {
        console.log(`[oracle-bot] ⏳ Oracle already fresh (id=${roundId}), skipping`);
        return;
      }

      // Push price
      const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');
      const confirmedNonce = await provider.getTransactionCount(wallet.address, 'latest');
      let nonce = pendingNonce;
      if (pendingNonce > confirmedNonce + 5) {
        console.warn(`[oracle-bot] ⚠️ Nonce gap detected, using confirmedNonce=${confirmedNonce}`);
        nonce = confirmedNonce;
      }

      await pushPrice(price, nonce);
    } else {
      console.log(`[oracle-bot] ⏸ Not in lock window, skipping`);
    }
  } catch (err) {
    console.error(`[oracle-bot] ❌ Error: ${err.message}`);
  }
}

// --- Startup ---
(async () => {
  console.log(`[oracle-bot] Starting for ${ASSET} with wallet ${wallet.address}...`);
  while (true) {
    await loop();
    await sleep(Number(CHECK_INTERVAL));
  }
})();
