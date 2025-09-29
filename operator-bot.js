import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  OPERATOR_KEY, // separate from oracle key
  PREDICTION_ADDRESS,
  CHECK_INTERVAL = 5000,
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,
  SAFE_DELAY = 2,
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or OPERATOR_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;
let lastExecutedEpoch = 0;

// --- Utility ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function sendTx(fn) {
  const tx = await fn({
    gasLimit: Number(GAS_LIMIT),
    gasPrice: ethers.parseUnits("1000", "gwei"), // hard fixed
  });
  console.log(`[operator-bot] Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt;
}

// --- Bootstrap genesis ---
async function bootstrapGenesis() {
  const startOnce = await prediction.genesisStartOnce();
  const lockOnce = await prediction.genesisLockOnce();

  if (!startOnce) {
    console.log(`[operator-bot] ⚡ genesisStartRound`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${receipt.hash})`);
    return true;
  }

  if (startOnce && !lockOnce) {
    console.log(`[operator-bot] ⚡ genesisLockRound`);
    const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${receipt.hash})`);
    return true;
  }

  return false;
}

// --- Execute a finished epoch ---
async function tryExecute(epoch) {
  if (epoch <= lastExecutedEpoch) return false;

  const round = await prediction.rounds(epoch);
  const now = Math.floor(Date.now() / 1000);

  const lockTime = Number(round.lockTimestamp);
  const closeTime = Number(round.closeTimestamp);
  const oracleCalled = round.oracleCalled;

  // safe condition: oracle updated + lock passed
  if (
    lockTime > 0 &&
    oracleCalled &&
    now >= lockTime + Number(SAFE_DELAY) &&
    now <= closeTime + Number(BUFFER_SECONDS)
  ) {
    console.log(`[operator-bot] Executing epoch ${epoch} now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`);
    txPending = true;
    try {
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ Executed epoch ${epoch} (${receipt.hash})`);
      lastExecutedEpoch = epoch;
      return true;
    } finally {
      txPending = false;
    }
  }

  if (lockTime > 0 && now > closeTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ⏩ Missed epoch ${epoch} (lock=${ts(lockTime)} close=${ts(closeTime)})`);
    lastExecutedEpoch = epoch;
  }

  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const currentEpoch = Number(await prediction.currentEpoch());

    // ✅ Only execute previous epoch, not current
    if (currentEpoch > 1) {
      await tryExecute(currentEpoch - 1);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
