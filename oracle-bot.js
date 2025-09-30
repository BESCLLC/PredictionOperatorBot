import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import OracleAbi from './abi/SimpleOracleForPredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  ORACLE_ADDRESS,
  PRIVATE_KEY,
  ASSET = 'bitcoin',
  INTERVAL = 10000, // 10s
  GAS_LIMIT = 200000,
  GAS_PRICE_GWEI = 1000,
} = process.env;

if (!RPC_URL || !ORACLE_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, ORACLE_ADDRESS, or PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const oracle = new ethers.Contract(ORACLE_ADDRESS, OracleAbi, wallet);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------- Fetch price --------------------
async function fetchPrice() {
  const maxRetries = 5;
  let attempt = 1;

  while (attempt <= maxRetries) {
    try {
      const r = await axios.get(
        'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD'
      );
      const price = Number(r.data.price);
      if (!price) throw new Error('Price not found');
      return BigInt(Math.round(price * 1e8)); // scale to 1e8
    } catch (err) {
      if (err.response?.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(
          `[oracle-bot] ⚠️ Rate limit, retrying in ${delay}ms (attempt ${
            attempt + 1
          }/${maxRetries})`
        );
        await sleep(delay);
        attempt++;
      } else {
        console.error(`[oracle-bot] ❌ Fetch price error: ${err.message}`);
        throw err;
      }
    }
  }
  throw new Error('Max retries reached for Binance API');
}

// -------------------- Push to Oracle --------------------
async function updateOracle() {
  try {
    const price = await fetchPrice();
    console.log(`[oracle-bot] Price: $${Number(price) / 1e8}`);

    const pendingNonce = await provider.getTransactionCount(
      wallet.address,
      'pending'
    );
    const confirmedNonce = await provider.getTransactionCount(
      wallet.address,
      'latest'
    );

    let nonce = pendingNonce;
    if (pendingNonce > confirmedNonce + 10) {
      console.warn(
        `[oracle-bot] ⚠️ Large nonce gap detected, resetting to confirmed=${confirmedNonce}`
      );
      nonce = confirmedNonce;
    }

    const tx = await oracle.updatePrice(price, {
      gasLimit: Number(GAS_LIMIT),
      gasPrice: ethers.parseUnits(String(GAS_PRICE_GWEI), 'gwei'),
      nonce,
    });

    console.log(
      `[oracle-bot] 🚀 Oracle update tx sent: ${tx.hash}, nonce=${nonce}`
    );
    await tx.wait(2);
    console.log(`[oracle-bot] ✅ Oracle price updated on-chain`);
  } catch (err) {
    console.error(`[oracle-bot] ❌ Error: ${err.message}`);
  }
}

// -------------------- Main loop --------------------
console.log(
  `[oracle-bot] Starting for ${ASSET}... using wallet ${wallet.address}`
);
updateOracle();
setInterval(updateOracle, Number(INTERVAL));
