import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
import { getConfig, setConfig } from "./db.js";

// MEXC 거래소 API 베이스 주소
const MEXC_BASE = "https://api.mexc.com";

// 스테이블코인 분류 목록 (원화 역산용)
const STABLECOINS = new Set([
  "USDT", "USDTBSC", "USDTTRC", "USDTARBITRUM", "USDTSOL",
  "USDTAVAX", "USDTMATIC", "USDC", "USDCBSC", "USDCETH",
  "USDCSOL", "USDCMATIC", "USDCOP", "USDCAVAX"
]);

// 업비트 마켓 매핑 목록
const UPBIT_MAP = {
  "BTC": "KRW-BTC",
  "ETH": "KRW-ETH",
  "SOL": "KRW-SOL",
  "BSC": "KRW-BNB",
  "BNB": "KRW-BNB",
  "XRP": "KRW-XRP",
  "DOGE": "KRW-DOGE",
  "LTC": "KRW-LTC",
  "TRX": "KRW-TRX",
  "AVAX": "KRW-AVAX",
  "POL": "KRW-POL"
};

// handlers.js의 코인 선택 UI가 지원하는 코인 목록 (getRates에서 전부 단가를 채워줌)
const SUPPORTED_COINS = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "TRX", "LTC", "POL", "AVAX",
  "USDT", "USDTBSC", "USDTTRC", "USDTSOL", "USDCBSC",
];

/* ============================================================
   시세 및 외부 API 연동 기능
============================================================ */

async function getUpbitPrice(market) {
  try {
    const response = await axios.get(`https://api.upbit.com/v1/ticker?markets=${market}`);
    return parseFloat(response.data[0].trade_price);
  } catch (error) {
    console.error(`업비트 ${market} 시세 조회 실패:`, error.message);
    throw error;
  }
}

async function getUsdtKrw() {
  try {
    return await getUpbitPrice("KRW-USDT");
  } catch {
    return 1467;
  }
}

/**
 * 바이낸스 현물 시세 범용 조회 (예: "BNBUSDT", "SOLUSDT") — 시세 표시/계산기 용도
 */
async function getBinancePrice(symbol) {
  try {
    const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(response.data.price);
  } catch (error) {
    console.error(`바이낸스 ${symbol} 시세 조회 실패:`, error.message);
    throw error;
  }
}

async function getBinanceBnbPrice() {
  return getCoinUsdPriceRobust("BNB");
}

// 코인게코(CoinGecko) ID 매핑 (바이낸스가 지역차단 등으로 막혔을 때 2차 폴백용)
const COINGECKO_ID_MAP = {
  BTC: "bitcoin", ETH: "ethereum", BNB: "binancecoin", SOL: "solana",
  XRP: "ripple", DOGE: "dogecoin", TRX: "tron", LTC: "litecoin",
  POL: "matic-network", AVAX: "avalanche-2",
};

// 코인게코 결과 캐시 (짧은 시간 내 반복 조회로 인한 429 방지)
const _coinGeckoPriceCache = new Map(); // cgId -> { price, at }
const COINGECKO_CACHE_MS = 30_000;
let _coinGeckoInflight = null; // 동시에 여러 코인이 캐시미스 나도 요청은 1번만 나가도록 공유

/**
 * 알고 있는 모든 코인 시세를 "한 번의 요청"으로 일괄 조회해서 캐시에 채워 넣음.
 * 동시에 여러 곳(예: getRates()의 Promise.all)에서 캐시미스가 나도, 이미 진행 중인
 * 요청이 있으면 그 결과를 같이 기다리게 해서 중복 요청(=429의 원인)을 막음.
 */
async function fetchCoinGeckoBulk() {
  if (_coinGeckoInflight) return _coinGeckoInflight;

  _coinGeckoInflight = (async () => {
    const allIds = [...new Set(Object.values(COINGECKO_ID_MAP))];
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${allIds.join(",")}&vs_currencies=usd`,
      { timeout: 5000 }
    );
    const now = Date.now();
    for (const cgId of allIds) {
      const price = response.data?.[cgId]?.usd;
      if (price) _coinGeckoPriceCache.set(cgId, { price, at: now });
    }
    return response.data;
  })();

  try {
    return await _coinGeckoInflight;
  } finally {
    _coinGeckoInflight = null;
  }
}

async function getCoinGeckoUsdPrice(coin) {
  const id = COINGECKO_ID_MAP[coin] || coin.toLowerCase();
  const now = Date.now();

  const cached = _coinGeckoPriceCache.get(id);
  if (cached && (now - cached.at < COINGECKO_CACHE_MS)) {
    return cached.price;
  }

  await fetchCoinGeckoBulk();

  const result = _coinGeckoPriceCache.get(id);
  if (!result) throw new Error(`코인게코에서 ${coin} 가격을 찾을 수 없습니다.`);
  return result.price;
}

/**
 * 코인 1개당 USD 가격 조회 (1차: 바이낸스, 2차: 코인게코)
 */
async function getCoinUsdPriceRobust(coin) {
  const alias = coin === "BSC" ? "BNB" : coin;
  const symbol = BINANCE_SYMBOL_MAP[alias] || `${alias}USDT`;
  try {
    return await getBinancePrice(symbol);
  } catch (error) {
    console.warn(`바이낸스 실패, 코인게코로 폴백 시도: ${alias} (${error.message})`);
    return await getCoinGeckoUsdPrice(alias);
  }
}

/**
 * 실시간 달러(USD) → 원화(KRW) 환율 사이트 조회
 */
async function getUsdKrwRate() {
  try {
    const response = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 4000 });
    const rate = response.data?.rates?.KRW;
    if (rate) return rate;
  } catch (error) {
    console.error("환율 사이트(USD/KRW) 조회 실패:", error.message);
  }
  return await getUsdtKrw();
}

// 바이낸스 심볼 매핑 (코인 코드가 바이낸스 티커와 다른 경우만 명시)
const BINANCE_SYMBOL_MAP = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", BNB: "BNBUSDT", SOL: "SOLUSDT",
  XRP: "XRPUSDT", DOGE: "DOGEUSDT", TRX: "TRXUSDT", LTC: "LTCUSDT",
  POL: "POLUSDT", AVAX: "AVAXUSDT",
};

/**
 * 계산기 전용 코인 단가(KRW) 조회
 */
export async function getCalcCoinKrwPrice(coin) {
  const c = coin.trim().toUpperCase();
  const usdKrw = await getUsdKrwRate();

  if (STABLECOINS.has(c)) {
    return usdKrw;
  }

  const alias = c === "BSC" ? "BNB" : c;

  try {
    const coinUsdt = await getCoinUsdPriceRobust(alias);
    return coinUsdt * usdKrw;
  } catch (error) {
    console.error(`계산기: ${coin} 시세 조회 실패 (바이낸스+코인게코 모두 실패):`, error.message);
    return 0;
  }
}

/**
 * 코인 1개당 원화(KRW) 단가 조회 공통 로직 (메인 패널/견적 표시용)
 */
async function getCoinKrwPrice(coin, usdtKrw, bnbUsdt) {
  const c = coin.trim().toUpperCase();

  if (STABLECOINS.has(c)) return usdtKrw;

  if (c === "BNB" || c === "BSC") {
    if (bnbUsdt > 0) return bnbUsdt * usdtKrw;
  }

  if (UPBIT_MAP[c]) {
    try {
      return await getUpbitPrice(UPBIT_MAP[c]);
    } catch {
      // 실패 시 아래 폴백으로 우회
    }
  }

  try {
    const coinUsd = await getCoinUsdPriceRobust(c);
    return coinUsd * usdtKrw;
  } catch (error) {
    console.error(`${coin} 시세 조회 실패 (바이낸스+코인게코 모두 실패):`, error.message);
  }

  return 0;
}

/* ============================================================
   MEXC 거래소 API 헬퍼
============================================================ */

function strictEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function mexcSign(queryString) {
  const secretKey = process.env.MEXC_API_SECRET?.trim();
  return crypto.createHmac("sha256", secretKey).update(queryString).digest("hex");
}

async function mexcRequest(method, endpoint, params = {}, signed = true) {
  const apiKey = process.env.MEXC_API_KEY?.trim();
  const secretKey = process.env.MEXC_API_SECRET?.trim();

  if (signed && (!apiKey || !secretKey)) {
    throw new Error(".env 파일에 MEXC_API_KEY 또는 MEXC_API_SECRET이 없습니다.");
  }

  const query = { ...params };
  if (signed) {
    query.timestamp = Date.now();
    query.recvWindow = query.recvWindow || 5000;
  }

  let queryString = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  if (signed) {
    const signature = mexcSign(queryString);
    queryString += `&signature=${signature}`;
  }

  const url = `${MEXC_BASE}${endpoint}${queryString ? `?${queryString}` : ""}`;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { "X-MEXC-APIKEY": apiKey } : {}),
  };

  try {
    const response = await axios({ method, url, headers });
    return response.data;
  } catch (error) {
    console.error("─────────────────────────────────────────");
    console.error(`❌ MEXC API 요청 실패: ${method} ${endpoint}`);
    if (error.response) {
      console.error("응답 상태코드:", error.response.status);
      console.error("응답 바디:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("응답 없음 (네트워크/타임아웃 등):", error.message);
    }
    console.error("─────────────────────────────────────────");
    const msg = error.response?.data?.msg || error.message;
    throw new Error(msg);
  }
}

function resolveMexcCoin(toCoin) {
  const c = toCoin.trim().toUpperCase();
  if (c === "USDTBSC") return { coin: "USDT", aliases: ["BSC", "BEP20"] };
  if (c === "USDTTRC") return { coin: "USDT", aliases: ["TRC20", "TRX"] };
  if (c === "USDTSOL") return { coin: "USDT", aliases: ["SOL"] };
  if (c === "USDT")    return { coin: "USDT", aliases: ["BSC", "BEP20"] };
  if (c === "BNB" || c === "BSC") return { coin: "BNB", aliases: ["BSC"] };
  return { coin: c, aliases: [c] };
}

async function resolveWithdrawNetwork(coin, aliases) {
  if (coin.toUpperCase() === "USDT" && aliases.includes("BEP20(BSC)")) {
     return "BEP20(BSC)";
  }
  if (coin.toUpperCase() === "USDT" && aliases.includes("TRC20")) {
     return "TRC20";
  }

  try {
    const config = await getMexcCoinConfig();
    const entry = config.find(c => c.coin?.toUpperCase() === coin.toUpperCase());
    if (entry?.networkList?.length) {
      for (const alias of aliases) {
        const match = entry.networkList.find(n =>
          (n.netWork || n.network || "").toUpperCase() === alias.toUpperCase() && n.withdrawEnable
        );
        if (match) return match.netWork || match.network;
      }
    }
  } catch (error) {
    console.warn(`네트워크 조회 실패: ${error.message}`);
  }
  return aliases[0];
}

/**
 * MEXC 시장가 매수: USDT로 coin을 즉시 매수
 */
async function mexcMarketBuy(coin, usdtAmount) {
  const symbol = `${coin.toUpperCase()}USDT`;
  const quoteOrderQty = usdtAmount.toFixed(2);

  if (Number(quoteOrderQty) < 1) {
    throw new Error(`최소 주문 금액(1 USDT) 미만입니다. (계산된 금액: ${quoteOrderQty} USDT)`);
  }

  const data = await mexcRequest("post", "/api/v3/order", {
    symbol,
    side: "BUY",
    type: "MARKET",
    quoteOrderQty,
  }, true);

  if (!data || data.code) {
    throw new Error(data?.msg || "MEXC 주문 생성 실패");
  }

  let executedQty = parseFloat(data.executedQty || "0");

  if (!executedQty && data.orderId) {
    await new Promise(r => setTimeout(r, 1500));
    const order = await mexcRequest("get", "/api/v3/order", { symbol, orderId: data.orderId }, true);
    executedQty = parseFloat(order.executedQty || "0");
  }

  if (!executedQty) {
    throw new Error("MEXC 주문 체결 수량을 확인할 수 없습니다.");
  }

  return { executedQty, orderId: data.orderId };
}

/**
 * MEXC 출금 신청
 */
async function mexcWithdraw(coin, network, address, amount) {
  const apiKey = process.env.MEXC_API_KEY?.trim();
  const secretKey = process.env.MEXC_API_SECRET?.trim();
  if (!apiKey || !secretKey) {
    throw new Error(".env 파일에 MEXC_API_KEY 또는 MEXC_API_SECRET이 없습니다.");
  }

  const params = {
    coin,
    address,
    amount: amount.toString(),
    netWork: network,
    network,
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  console.log("-----------------------------------------");
  console.log("DEBUG: 출금 요청 파라미터:", JSON.stringify(params, null, 2));
  console.log("-----------------------------------------");
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${strictEncode(v)}`)
    .join("&");
  const signature = crypto.createHmac("sha256", secretKey).update(queryString).digest("hex");
  const url = `${MEXC_BASE}/api/v3/capital/withdraw?${queryString}&signature=${signature}`;

  let data;
  try {
    const response = await axios.post(url, null, {
      headers: { "Content-Type": "application/json", "X-MEXC-APIKEY": apiKey },
    });
    data = response.data;
  } catch (error) {
    console.error("─────────────────────────────────────────");
    console.error("❌ MEXC API 요청 실패: post /api/v3/capital/withdraw");
    if (error.response) {
      console.error("응답 상태코드:", error.response.status);
      console.error("응답 바디:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("응답 없음:", error.message);
    }
    console.error("─────────────────────────────────────────");
    throw new Error(error.response?.data?.msg || error.message);
  }

  if (!data || data.code) {
    throw new Error(data?.msg || "MEXC 출금 신청 실패");
  }

  return { withdrawId: data.id };
}

function getExplorerLink(coin, hash) {
  switch (coin.toLowerCase()) {
    case "sol": return `https://solscan.io/tx/${hash}`;
    case "ltc": return `https://live.blockcypher.com/ltc/tx/${hash}`;
    case "trx": return `https://tronscan.org/#/transaction/${hash}`;
    default: return `https://bscscan.com/tx/${hash}`;
  }
}
export { getExplorerLink };

/**
 * MEXC 출금내역 조회 (GET /api/v3/capital/withdraw/history).
 * 🔧 [신규] 출금 신청 직후 반환되는 id는 MEXC 내부 출금ID일 뿐, 실제
 * 블록체인 TXID(txId)가 아님. txId는 거래소가 실제로 온체인에
 * 브로드캐스트한 뒤에야 채워짐.
 */
async function getMexcWithdrawRecord(withdrawId) {
  const data = await mexcRequest("get", "/api/v3/capital/withdraw/history", { limit: 50 }, true);
  if (!Array.isArray(data)) return null;
  return data.find(r => String(r.id) === String(withdrawId)) || null;
}

/**
 * 🔧 [신규] 출금 신청 직후 진짜 TXID가 채워질 때까지 백그라운드에서 주기적으로
 * 출금내역을 조회함(폴링). Discord 인터랙션을 붙잡아두지 않도록 fire-and-forget
 * 방식으로 동작하며, 찾으면 onFound 콜백으로 알려줌.
 */
export function pollMexcWithdrawTx(withdrawId, { onFound, maxAttempts = 40, intervalMs = 15000 } = {}) {
  let attempts = 0;
  const tick = async () => {
    attempts++;
    try {
      const record = await getMexcWithdrawRecord(withdrawId);
      if (record?.txId) {
        if (typeof onFound === "function") await onFound(record.txId, record);
        return; // 찾았으니 폴링 종료
      }
    } catch (e) {
      console.error(`출금내역 폴링 실패 (${withdrawId}, 시도 ${attempts}/${maxAttempts}):`, e.message);
    }
    if (attempts < maxAttempts) {
      setTimeout(tick, intervalMs);
    } else {
      console.warn(`⚠️ 출금 ${withdrawId}의 실제 TXID를 ${maxAttempts}회 시도 후에도 찾지 못했습니다.`);
    }
  };
  tick();
}

/* ============================================================
   통합 스왑 송금 프로세스 (MEXC 기반)
   🔧 [수정] 반환하는 hash는 여전히 MEXC 내부 출금ID임(즉시 알 수 있는 값은
   이것뿐이라서). 실제 TXID는 processSwapTransfer 호출 이후 handlers.js에서
   pollMexcWithdrawTx()로 별도 확인해야 함.
============================================================ */
export async function processSwapTransfer(fromCoin, toCoin, krwAmount, toAddress) {
  if (!toAddress) {
    throw new Error("수신 지갑 주소가 전달되지 않았습니다.");
  }

  const coin = toCoin.trim().toUpperCase();
  let feeRate = 0;

  if (coin.startsWith("BNB") || coin.startsWith("BSC")) {
    feeRate = 0.019;
  }
  if (coin.startsWith("LTC")) {
    feeRate = 0.023;
  }
  if (coin.startsWith("TRX")) {
    feeRate = 0.016;
  }
  if (coin.startsWith("SOL")) {
    feeRate = 0.007;
  }
  if (coin.startsWith("USDT")) {
    feeRate = 0.012;
  }

  const finalKrwAmount = krwAmount * (1 - feeRate);

  if (feeRate !== 0) {
    console.log(`[송금] ${coin} 수수료 적용: +${(feeRate * 100).toFixed(2)}% (적용 전: ₩${krwAmount.toLocaleString()} → 적용 후: ₩${finalKrwAmount.toLocaleString()})`);
  }

  const { coin: mexcCoin, aliases } = resolveMexcCoin(toCoin);

  console.log(`[1/4] 원화 ₩${finalKrwAmount.toLocaleString()} → USDT 환산 중...`);
  const usdtKrw = await getUsdtKrw();
  const usdtAmount = finalKrwAmount / usdtKrw;
  console.log(`👉 사용할 USDT: ${usdtAmount.toFixed(4)} USDT (환율 ₩${usdtKrw.toLocaleString()}/USDT)`);

  let receivedQty;

  if (STABLECOINS.has(coin)) {
    console.log(`[2/4] 목표 코인이 USDT 계열이라 매수 단계를 건너뜁니다.`);
    receivedQty = usdtAmount;
  } else {
    console.log(`[2/4] MEXC에서 ${mexcCoin} 시장가 매수 중...`);
    const buyResult = await mexcMarketBuy(mexcCoin, usdtAmount);
    receivedQty = buyResult.executedQty;
    console.log(`👉 매수 체결: ${receivedQty} ${mexcCoin}`);
  }

  console.log(`[3/4] 출금 네트워크 확인 중...`);
  const network = await resolveWithdrawNetwork(mexcCoin, aliases);
  console.log(`👉 출금 네트워크: ${network}`);

  console.log(`[4/4] MEXC 출금 신청 중... (${receivedQty} ${mexcCoin} → ${toAddress})`);
  const { withdrawId } = await mexcWithdraw(mexcCoin, network, toAddress, receivedQty);
  console.log(`👉 출금 신청 완료 (ID: ${withdrawId}) — 실제 TXID는 별도로 폴링해서 확인해야 함`);

  return {
    hash: withdrawId,      // ⚠️ 아직 MEXC 내부 출금ID일 뿐, 실제 TXID가 아님
    explorer: null,        // 진짜 TXID를 알기 전까진 explorer 링크도 만들 수 없음
    receivedQty,
    withdrawId,
    coin: toCoin,
  };
}

/* ============================================================
   환율 조회
============================================================ */
export async function getRates(neededCoins = []) {
  const [cgRes, upbitBtcRes, binanceBnbRes] = await Promise.allSettled([
    axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`, { timeout: 4000 }),
    getUpbitPrice("KRW-BTC"),
    getBinanceBnbPrice()
  ]);

  const usdtKrw = await getUsdtKrw();
  const bnbUsdt = binanceBnbRes.status === "fulfilled" ? binanceBnbRes.value : 0;
  const bnbKrw = bnbUsdt * usdtKrw;

  const rates = {
    USDT: usdtKrw,
    BNB: bnbKrw,
    BNB_KRW: bnbKrw,
    btcKimp: 0
  };

  const toFetch = [...new Set(neededCoins)].filter(c => c !== "USDT" && c !== "BNB" && c !== "USDTBSC");
  if (toFetch.length > 0) {
    const results = await Promise.all(
      toFetch.map(c => getCoinKrwPrice(c, usdtKrw, bnbUsdt))
    );
    toFetch.forEach((c, i) => { rates[c] = results[i]; });
  }
  if (neededCoins.includes("USDTBSC")) rates.USDTBSC = usdtKrw;

  if (cgRes.status === "fulfilled" && upbitBtcRes.status === "fulfilled") {
    const cgBtcUsd = cgRes.value.data.bitcoin?.usd ?? 0;
    const upbitBtc = upbitBtcRes.value;
    const calcCgBtcKrw = cgBtcUsd * usdtKrw;

    rates.upbitBtcKrw = upbitBtc;
    rates.globalBtcKrw = calcCgBtcKrw;

    if (calcCgBtcKrw > 0 && upbitBtc > 0) {
      rates.btcKimp = ((upbitBtc / calcCgBtcKrw) - 1) * 100;
    }
  }

  return rates;
}

/* ============================================================
   재고(MEXC 계정 USDT 잔고) KRW 환산
============================================================ */
export async function getBalancesKRW() {
  try {
    const rates = await getRates();

    let usdtBal = 0;
    try {
      const account = await mexcRequest("get", "/api/v3/account", {}, true);
      const usdtBalance = account.balances?.find(b => b.asset === "USDT");
      usdtBal = usdtBalance ? parseFloat(usdtBalance.free) : 0;
    } catch (e) {
      console.error("MEXC 잔고 조회 실패:", e.message);
    }

    const usdtKrw  = usdtBal * rates.USDT;
    const totalKrw = usdtKrw;

    return {
      bnbBal: 0, ltcBal: 0, trxBal: 0, usdtBal, solBal: 0,
      bnbKrw: 0, ltcKrw: 0, trxKrw: 0, usdtKrw, solKrw: 0,
      totalKrw,
      bnbKrwRate: rates.BNB_KRW ?? 0,
      rates: {
        btcKimp: rates.btcKimp ?? 0,
        upbitBtcKrw: rates.upbitBtcKrw ?? 0,
        globalBtcKrw: rates.globalBtcKrw ?? 0,
      },
    };
  } catch (e) {
    console.error("잔액 조회 실패:", e.message);
    return {
      bnbBal: 0, ltcBal: 0, trxBal: 0, usdtBal: 0, solBal: 0,
      bnbKrw: 0, ltcKrw: 0, trxKrw: 0, usdtKrw: 0, solKrw: 0,
      totalKrw: 0, bnbKrwRate: 0,
      rates: { btcKimp: 0, upbitBtcKrw: 0, globalBtcKrw: 0 },
    };
  }
}

/* ============================================================
   로그 채널 전송
============================================================ */
export async function sendLog(client, type, fields) {
  try {
    const ch = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const icon  = type === "success" ? "✅" : type === "fail" ? "❌" : "📋";
    const lines = Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`).join("\n");
    const now   = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    await ch.send(`${icon} **[${type.toUpperCase()}]** ${now}\n${lines}`);
  } catch (e) { console.error("로그 전송 실패:", e.message); }
}

/* ============================================================
   입고 알림 (MEXC USDT 잔고 증가 감지)
============================================================ */
let _prevUsdtKrw = null;
let _prevUsdtKrwLoaded = false;

export async function checkAndNotifyRestock(client, onRestock) {
  try {
    if (!_prevUsdtKrwLoaded) {
      const stored = getConfig("prev_usdt_krw");
      _prevUsdtKrw = stored !== null ? parseFloat(stored) : null;
      _prevUsdtKrwLoaded = true;
    }

    const b = await getBalancesKRW();
    console.log(`[재고체크] 현재 USDT잔고: ₩${Math.round(b.usdtKrw).toLocaleString()} / 기준값: ${_prevUsdtKrw === null ? "없음(최초)" : "₩" + Math.round(_prevUsdtKrw).toLocaleString()}`);

    if (_prevUsdtKrw === null) {
      _prevUsdtKrw = b.usdtKrw;
      setConfig("prev_usdt_krw", b.usdtKrw);
      console.log("[재고체크] 최초 실행 - 기준값만 설정하고 이번엔 알림 없이 넘어감");
      return;
    }

    const diff = Math.round(b.usdtKrw - _prevUsdtKrw);
    console.log(`[재고체크] 차이: ${diff >= 0 ? "+" : ""}₩${diff.toLocaleString()} (임계값: 10,000원 이상일 때 알림)`);
    if (diff >= 10000) {
      const ch = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
      if (ch) await ch.send(`📦 MEXC USDT 입고 감지: +₩${diff.toLocaleString()} (총 ₩${Math.round(b.usdtKrw).toLocaleString()})`);

      if (typeof onRestock === "function") {
        await onRestock(diff, Math.round(b.usdtKrw));
      }
      setConfig("prev_usdt_krw", b.usdtKrw);
    }

    _prevUsdtKrw = b.usdtKrw;
  } catch (e) { console.error("입고 알림 체크 실패:", e.message); }
}