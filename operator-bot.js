import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  OPERATOR_KEY,             // ✅ changed from PRIVATE_KEY so oracle can use its own key
  CHECK_INTERVAL = 5000,    // run every 5s
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,      // must match contract setting
  SAFE_DELAY = 2,           // safety delay after lock before execute
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or OPERATOR_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;

// --- Helpers ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function sendTx(fn) {
  try {
    const tx = await fn({
      gasLimit: Number(GAS_LIMIT),
      maxFeePerGas: ethers.parseUnits("1000", "gwei"),        // ✅ locked to 1000 gwei
      maxPriorityFeePerGas: ethers.parseUnits("1000", "gwei"),
    });
    console.log(`[operator-bot] Tx sent: ${tx.hash}`);
    return await tx.wait();
  } catch (err) {
    console.error(`[operator-bot] ❌ Tx error: ${err.message}`);
    throw err;
  }
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ genesisStartRound`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${receipt.transactionHash})`);
    return true;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);
    const lockTime = Number(round.lockTimestamp);

    if (now >= lockTime) {
      console.log(`[operator-bot] ⚡ genesisLockRound`);
      const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
      console.log(`[operator-bot] ✅ genesisLockRound (${receipt.transactionHash})`);
      return true;
    } else {
      console.log(`[operator-bot] ⏳ Not time to lock yet (now=${ts(now)} lock=${ts(lockTime)})`);
    }
  }
  return false;
}

// --- Normal round execution ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    // Lock new round
    if (lockTime > 0 && now >= lockTime && now <= lockTime + Number(BUFFER_SECONDS)) {
      console.log(`[operator-bot] ⚡ Locking round ${epoch.toString()}...`);
      txPending = true;
      const receipt = await sendTx((opts) => prediction.lockRound(opts));
      console.log(`[operator-bot] ✅ Round locked (${receipt.transactionHash})`);
      txPending = false;
      return;
    }

    // Execute round
    if (closeTime > 0 && now >= closeTime + Number(SAFE_DELAY) && now <= closeTime + Number(BUFFER_SECONDS)) {
      console.log(`[operator-bot] ⚡ Executing round ${epoch.toString()}...`);
      txPending = true;
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ Round executed (${receipt.transactionHash})`);
      txPending = false;
      return;
    }

    console.log(`[operator-bot] Waiting... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`);
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
