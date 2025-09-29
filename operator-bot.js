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

// Hard floor = 1000 gwei
const MIN_GAS_PRICE = ethers.parseUnits("1000", "gwei");

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
  try {
    let feeData = await provider.getFeeData();

    // Default to RPC gasPrice if missing
    let gasPrice = feeData.gasPrice || MIN_GAS_PRICE;

    // Enforce 1000 gwei minimum
    if (gasPrice < MIN_GAS_PRICE) {
      gasPrice = MIN_GAS_PRICE;
    }

    const overrides = {
      gasLimit: Number(GAS_LIMIT),
      gasPrice,
    };

    const tx = await fn()(overrides);
    console.log(`[operator-bot] Tx sent: ${tx.hash}`);
    await tx.wait();
    return tx;
  } catch (err) {
    console.error(`[operator-bot] ❌ Error sending tx: ${err.message}`);
    throw err;
  }
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
