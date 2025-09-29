import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 30000,
  GAS_LIMIT = 500000,
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

// ---------- GENESIS BOOTSTRAP ----------
async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisStartRound...`);
    const tx = await sendTx(() => prediction.genesisStartRound);
    console.log(`[operator-bot] ✅ genesisStartRound executed (${tx.hash})`);
    return true;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisLockRound...`);
    const tx = await sendTx(() => prediction.genesisLockRound);
    console.log(`[operator-bot] ✅ genesisLockRound executed (${tx.hash})`);
    return true;
  }

  return false;
}

// ---------- SAFE TX SENDER ----------
async function sendTx(fn) {
  let attempt = 0;
  let lastError;

  while (attempt < 5) {
    try {
      // dynamic fee data
      const feeData = await provider.getFeeData();

      const overrides = {
        gasLimit: Number(GAS_LIMIT),
      };

      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        overrides.maxFeePerGas = feeData.maxFeePerGas;
        overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      } else {
        // fallback to legacy gasPrice if RPC doesn’t support EIP-1559
        overrides.gasPrice = await provider.getGasPrice();
      }

      const tx = await fn()(overrides);
      console.log(`[operator-bot] Tx sent: ${tx.hash}`);
      await tx.wait();
      return tx;
    } catch (err) {
      lastError = err;
      if (err.code === 'REPLACEMENT_UNDERPRICED' || err.message.includes('replacement fee too low')) {
        console.log(`[operator-bot] ⬆️ Replacement underpriced, bumping gas...`);
        // bump gas by 10% and retry
        const gasPrice = await provider.getGasPrice();
        fn().overrides = { gasPrice: gasPrice * 11n / 10n, gasLimit: Number(GAS_LIMIT) };
      } else {
        console.error(`[operator-bot] ❌ Error sending tx: ${err.message}`);
        break;
      }
    }
    attempt++;
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw lastError;
}

// ---------- MAIN LOOP ----------
async function checkAndExecute() {
  try {
    const didBootstrap = await bootstrapGenesis();
    if (didBootstrap) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    if (lockTime > 0 && now > closeTime) {
      console.log(`[operator-bot] Executing round ${epoch.toString()}...`);
      const tx = await sendTx(() => prediction.executeRound);
      console.log(`[operator-bot] ✅ Round executed (${tx.hash})`);
    } else {
      console.log(`[operator-bot] Waiting... now=${now} lock=${lockTime} close=${closeTime}`);
    }
  } catch (e) {
    console.error(`[operator-bot] ❌ Error: ${e.message}`);
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
