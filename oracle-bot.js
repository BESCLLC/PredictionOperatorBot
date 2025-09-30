import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import OracleAbi from './abi/SimpleOracleForPredictionV3.json' assert { type: 'json' };
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  ORACLE_ADDRESS,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  ASSET = 'bitcoin',
  INTERVAL = 10000, // 10s (should align with round timing)
  GAS_LIMIT = 300000,
  GAS_PRICE_GWEI = 1000,
} = process.env;

if (!RPC_URL || !ORACLE_ADDRESS || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, ORACLE_ADDRESS, PREDICTION_ADDRESS, or PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const oracle = new ethers.Contract(ORACLE_ADDRESS, OracleAbi, wallet);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------- PRICE FETCHER --------------------
async function fetchPrice() {
  const maxRetries = 5;
  let attempt = 1;

  while (attempt <= maxRetries) {
    try {
      const r = await axios.get('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD');
      const price = Number(r.data.price);
      if (!price) throw new Error('Price not found');
      return BigInt(Math.round(price * 1e8)); // scale to 1e8
    } catch (err) {
      if (err.response?.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[oracle-bot] ⚠️ Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        attempt++;
      } else {
        console.error(`[oracle-bot] ❌ Price fetch failed: ${err.message}`);
        throw err;
      }
    }
  }
  throw new Error('Max retries reached for price fetch');
}

// -------------------- ORACLE UPDATE --------------------
async function updateOracle() {
  try {
    const price = await fetchPrice();
    console.log(`[oracle-bot] Price: $${Number(price) / 1e8}`);

    const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');
    const confirmedNonce = await provider.getTransactionCount(wallet.address, 'latest');
    let nonce = pendingNonce;

    // Prevent runaway nonce gap
    if (pendingNonce > confirmedNonce + 10) {
      console.warn(`[oracle-bot] ⚠️ Large nonce gap, resetting to confirmed=${confirmedNonce}`);
      nonce = confirmedNonce;
    }

    // 1. Update Oracle contract
    const tx1 = await oracle.updatePrice(price, {
      gasLimit: Number(GAS_LIMIT),
      gasPrice: ethers.parseUnits(String(GAS_PRICE_GWEI), 'gwei'),
      nonce,
    });
    console.log(`[oracle-bot] Oracle update tx sent: ${tx1.hash}, nonce=${nonce}`);
    await tx1.wait(2);

    // 2. Notify Prediction contract
    const tx2 = await prediction.oracleUpdate({
      gasLimit: Number(GAS_LIMIT),
      gasPrice: ethers.parseUnits(String(GAS_PRICE_GWEI), 'gwei'),
      nonce: nonce + 1,
    });
    console.log(`[oracle-bot] Prediction oracleUpdate tx sent: ${tx2.hash}, nonce=${nonce + 1}`);
    await tx2.wait(2);

    console.log(`[oracle-bot] ✅ Oracle + Prediction updated successfully`);
  } catch (err) {
    console.error(`[oracle-bot] ❌ Error: ${err.message}`);
  }
}

// -------------------- MAIN LOOP --------------------
console.log(`[oracle-bot] Starting for ${ASSET}... Using wallet ${wallet.address}`);
updateOracle();
setInterval(updateOracle, Number(INTERVAL));
