import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  OPERATOR_KEY,             // 👈 renamed so oracle can use PRIVATE_KEY separately
  CHECK_INTERVAL = 5000,    // check every 5s
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,      // must match contract
  SAFE_DELAY = 2,           // wait a couple secs past lock/close
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or OPERATOR_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;

// --- Format timestamp ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// --- Send tx with retries ---
async function sendTx(fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tx = await fn({
        gasLimit: Number(GAS_LIMIT),
        maxFeePerGas: ethers.parseUnits("1000", "gwei"),   // 👈 fixed to 1000 gwei exactly
        maxPriorityFeePerGas: ethers.parseUnits("1000", "gwei"),
      });
      console.log(`[operator-bot] Tx sent (nonce ${tx.nonce}): ${tx.hash}`);
      const receipt = await tx.wait();
      return receipt;
    } catch (err) {
      console.error(`[operator-bot] ❌ Error (try ${attempt}): ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisStartRound...`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${receipt.transactionHash})`);
    return true;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisLockRound...`);
    const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${receipt.transactionHash})`);
    return true;
  }

  return false;
}

// --- Main loop ---
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

    // 🔒 Lock window
    if (
      lockTime > 0 &&
      now >= lockTime + Number(SAFE_DELAY) &&
      now <= lockTime + Number(BUFFER_SECONDS)
    ) {
      console.log(
        `[operator-bot] 🔒 Locking round ${epoch.toString()}... now=${ts(now)} lock=${ts(lockTime)}`
      );
      txPending = true;
      const receipt = await sendTx((opts) => prediction.lockRound(opts));
      console.log(`[operator-bot] ✅ lockRound (${receipt.transactionHash})`);
      txPending = false;
      return;
    }

    // ✅ Execute window
    if (
      closeTime > 0 &&
      now >= closeTime + Number(SAFE_DELAY) &&
      now <= closeTime + Number(BUFFER_SECONDS)
    ) {
      console.log(
        `[operator-bot] ✅ Executing round ${epoch.toString()}... now=${ts(now)} close=${ts(closeTime)}`
      );
      txPending = true;
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ executeRound (${receipt.transactionHash})`);
      txPending = false;
      return;
    }

    // Otherwise just waiting
    console.log(
      `[operator-bot] Waiting... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`
    );
  } catch (err) {
    console.error(`[operator-bot] ❌ Fatal error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
