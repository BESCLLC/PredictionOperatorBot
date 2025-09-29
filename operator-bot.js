import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 30000,
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30, // match your contract bufferSeconds
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

// Hard floor = 1000 gwei
const MIN_GAS_PRICE = ethers.parseUnits("1000", "gwei");

// Prevent overlapping transactions
let txPending = false;

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
  let gasPrice = MIN_GAS_PRICE;

  while (attempt < 5) {
    try {
      // ask RPC for suggestion, but enforce minimum
      const feeData = await provider.getFeeData();
      if (feeData.gasPrice && feeData.gasPrice > gasPrice) {
        gasPrice = feeData.gasPrice;
      }
      if (gasPrice < MIN_GAS_PRICE) gasPrice = MIN_GAS_PRICE;

      const overrides = {
        gasLimit: Number(GAS_LIMIT),
        gasPrice,
      };

      console.log(
        `[operator-bot] 🚀 Sending tx with gasPrice=${ethers.formatUnits(
          gasPrice,
          "gwei"
        )} gwei`
      );

      const tx = await fn()(overrides);
      console.log(`[operator-bot] Tx sent: ${tx.hash}`);
      await tx.wait();
      return tx;
    } catch (err) {
      if (
        err.code === "REPLACEMENT_UNDERPRICED" ||
        (err.message && err.message.includes("replacement fee too low"))
      ) {
        // bump gas by +50 gwei
        gasPrice = gasPrice + ethers.parseUnits("50", "gwei");
        console.log(
          `[operator-bot] ⬆️ Replacement underpriced, bumping gas to ${ethers.formatUnits(
            gasPrice,
            "gwei"
          )} gwei`
        );
        attempt++;
        continue;
      } else {
        console.error(`[operator-bot] ❌ Error sending tx: ${err.message}`);
        throw err;
      }
    }
  }

  throw new Error("Failed after 5 attempts");
}

// ---------- MAIN LOOP ----------
async function checkAndExecute() {
  if (txPending) {
    console.log("[operator-bot] Skipping: tx still pending...");
    return;
  }

  try {
    const didBootstrap = await bootstrapGenesis();
    if (didBootstrap) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    if (lockTime > 0 && now >= closeTime + Number(BUFFER_SECONDS)) {
      console.log(`[operator-bot] Executing round ${epoch.toString()}...`);
      txPending = true;
      const tx = await sendTx(() => prediction.executeRound);
      console.log(`[operator-bot] ✅ Round executed (${tx.hash})`);
      txPending = false;
    } else {
      console.log(
        `[operator-bot] Waiting... now=${now} lock=${lockTime} close=${closeTime}`
      );
    }
  } catch (e) {
    console.error(`[operator-bot] ❌ Error: ${e.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
