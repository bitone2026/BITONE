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
 * 🔧 바이낸스가 IP 지역차단 등으로 막히면 모든 코인 시세 조회가 한꺼번에
 * 실패하는 문제가 있어, 코인게코를 2차 폴백으로 추가함.
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
 * 업비트 KRW-USDT는 암호화폐 시세라 실제 달러 환율과 괴리가 있을 수 있어,
 * 계산기 기능에서는 실제 외환 환율 API를 우선 사용함.
 */
async function getUsdKrwRate() {
  try {
    const response = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 4000 });
    const rate = response.data?.rates?.KRW;
    if (rate) return rate;
  } catch (error) {
    console.error("환율 사이트(USD/KRW) 조회 실패:", error.message);
  }
  // 환율 사이트 실패 시 업비트 KRW-USDT 시세로 대체
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
 * 업비트에 상장되지 않은 코인이 많아, 바이낸스(실패 시 코인게코)의 코인/USDT 시세와
 * 실시간 달러 환율(USD/KRW)을 곱해 원화 단가를 구함.
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

  // 1. 스테이블코인
  if (STABLECOINS.has(c)) return usdtKrw;

  // 2. BNB 계열 (바이낸스/코인게코 시세 우선)
  if (c === "BNB" || c === "BSC") {
    if (bnbUsdt > 0) return bnbUsdt * usdtKrw;
  }

  // 3. 업비트 상장 코인
  if (UPBIT_MAP[c]) {
    try {
      return await getUpbitPrice(UPBIT_MAP[c]);
    } catch {
      // 실패 시 아래 폴백으로 우회
    }
  }

  // 4. Fallback: 바이낸스(실패 시 코인게코) 코인/USDT 시세 × 업비트 USDT/KRW
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
   🔧 FF.io 대신 MEXC에서 직접 USDT로 코인을 매수한 뒤 사용자 지갑으로
   출금하는 방식으로 전면 교체. .env에 MEXC_API_KEY / MEXC_API_SECRET 필요.
============================================================ */

/**
 * encodeURIComponent는 !, *, ', (, ) 를 인코딩하지 않고 그대로 둠.
 * MEXC 출금 네트워크 코드가 "Litecoin(LTC)"처럼 괄호를 포함하는 경우,
 * 이 괄호가 원문 그대로 전송되면서 서명 검증이 어긋나는(700002) 문제가 있어
 * AWS SigV4 등에서 쓰는 방식과 동일하게 추가로 엄격히 인코딩해줌.
 */
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
  // 🔧 GET/POST 모두 파라미터를 쿼리스트링으로 보내고 실제 body는 항상 비어있음.
  // MEXC는 body가 비어있을 때 Content-Type이 application/json이 아니면
  // HTTP 메서드와 무관하게 700013 "Invalid content Type."을 반환하는 것으로 확인됨
  // (application/x-www-form-urlencoded로 지정해도 동일하게 거부됨).
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

/**
 * 내부 코인 코드 → { coin, aliases } (MEXC 통화 코드 및 출금 네트워크 후보)로 변환
 */
// ... (위쪽 코드 생략, resolveMexcCoin부터 아래만 교체해도 됩니다)

function resolveMexcCoin(toCoin) {
  const c = toCoin.trim().toUpperCase();
  // USDTBSC인 경우 BEP20(BSC)를 최우선 별칭으로 사용
  if (c === "USDTBSC") return { coin: "USDT", aliases: ["BSC", "BEP20"] };
  if (c === "USDTTRC") return { coin: "USDT", aliases: ["TRC20", "TRX"] };
  if (c === "USDTSOL") return { coin: "USDT", aliases: ["SOL"] };
  if (c === "USDT")    return { coin: "USDT", aliases: ["BSC", "BEP20"] };
  if (c === "BNB" || c === "BSC") return { coin: "BNB", aliases: ["BSC"] };
  return { coin: c, aliases: [c] };
}

async function resolveWithdrawNetwork(coin, aliases) {
  // 💡 USDT 강제 네트워크 매핑 (디버그 로그에서 보신 DOTASSETHUB 같은 오류 방지)
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
// ... (이하 동일)



/**
 * MEXC 시장가 매수: USDT로 coin을 즉시 매수
 * quoteOrderQty = 사용할 USDT 금액
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

  // 즉시 체결 정보가 비어있는 경우 잠시 후 주문 상태를 재조회
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
 * 🔧 공식 문서 기준으로 두 가지를 수정:
 * 1. 엔드포인트: "/api/v3/capital/withdraw/apply"(구버전, 폐지 예정) →
 * "/api/v3/capital/withdraw"(신규)
 * 2. 파라미터명: "network" → "netWork"(대문자 W, 신규 필드명)
 * 매수/잔고조회 등 기존에 잘 작동하던 요청들은 건드리지 않고, 이 함수만
 * 별도로 자체 서명 로직을 사용함. netWork 값에 "BEP20(BSC)"처럼 괄호가
 * 포함될 수 있어(MEXC 공식 예시에도 존재), encodeURIComponent가 놓치는
 * 특수문자까지 인코딩하는 strictEncode를 이 요청에만 적용함.
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
    network,           // 문서상 예시/파라미터 표가 불일치하는 경우를 대비해 둘 다 전송
    timestamp: Date.now(),
    recvWindow: 5000,
  };
 // 💡 디버그 로그 추가 구간
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

/* ============================================================
   통합 스왑 송금 프로세스 (MEXC 기반)
   fromCoin: 더 이상 사용하지 않음 (항상 MEXC의 USDT 잔고에서 출발) — 기존
             handlers.js 호출부와의 호환을 위해 파라미터만 유지.
   toCoin:   사용자가 받고 싶은 코인
   krwAmount: 이미 "수수료(5%) + 현재 김프"가 차감된 원화 금액
              (handlers.js에서 feeRate = kimpRate + 0.05 로 미리 계산해서 넘김)
   toAddress: 사용자의 수신 지갑 주소

   흐름: krwAmount(원화, 수수료·김프 차감된 금액) → USDT 환산
        → MEXC에서 그 USDT만큼 toCoin 시장가 매수 → 매수한 수량 그대로 출금
============================================================ */
export async function processSwapTransfer(fromCoin, toCoin, krwAmount, toAddress) {
  if (!toAddress) {
    throw new Error("수신 지갑 주소가 전달되지 않았습니다.");
  }

  // --- [수정] LTC 코인만 수수료율 0.39% 반영 ---
  const coin = toCoin.trim().toUpperCase();
  let feeRate = 0;

  if (coin.startsWith("BNB") || coin.startsWith("BSC")) {
    feeRate = 0.014;
}

if (coin.startsWith("LTC")) {
    feeRate = 0.012;
}

if (coin.startsWith("TRX")) {
    feeRate = 0.0101;
}

if (coin.startsWith("SOL")) {
    feeRate = 0.007;
}

if (coin.startsWith("USDT")) {
    feeRate = 0.012;
}

  // 최종 적용할 금액 = 기존 krwAmount * (1 - 수수료율)
  const finalKrwAmount = krwAmount * (1 - feeRate);
  
  if (feeRate !== 0) {
      console.log(`[송금] ${coin} 수수료 적용: +${(feeRate * 100).toFixed(2)}% (적용 전: ₩${krwAmount.toLocaleString()} → 적용 후: ₩${finalKrwAmount.toLocaleString()})`);
  }
  // --- [수정] 수수료 적용 끝 ---

  const { coin: mexcCoin, aliases } = resolveMexcCoin(toCoin);

  console.log(`[1/4] 원화 ₩${finalKrwAmount.toLocaleString()} → USDT 환산 중...`);
  const usdtKrw = await getUsdtKrw();
  const usdtAmount = finalKrwAmount / usdtKrw;
  console.log(`👉 사용할 USDT: ${usdtAmount.toFixed(4)} USDT (환율 ₩${usdtKrw.toLocaleString()}/USDT)`);

  let receivedQty;

  if (STABLECOINS.has(coin)) {
    // 목표 코인이 스테이블코인(USDT 계열)이면 매수 단계 없이 그대로 사용
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
  console.log(`👉 출금 신청 완료 (ID: ${withdrawId})`);

  return {
    hash: withdrawId,
    explorer: getExplorerLink(toCoin, withdrawId),
    receivedQty, // 🔧 [추가] 실제로 매수/출금된 진짜 수량 (추정치가 아님) - 로그/기록에 이 값을 써야 정확함
  };
}

/* ============================================================
   환율 조회 — 바이낸스 BNB/USDT 및 업비트 KRW/USDT 연동
   🔧 [수정] 예전엔 호출할 때마다 SUPPORTED_COINS 전체(10개)를 다 조회해서
   API 요청이 낭비되고 있었음(대부분의 호출은 코인 1개만 필요함).
   이제 neededCoins로 명시한 코인만 추가 조회함 (기본값: 없음 = BTC 김프/USDT만).
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

  // 명시적으로 요청한 코인만 추가 조회 (USDT/BNB는 이미 위에서 채워졌으므로 제외)
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
   관리자 로그(LOG_CHANNEL_ID)는 여기서 그대로 처리하고,
   유저 대상 공개 입고알림은 onRestock 콜백으로 넘겨서
   handlers.js 쪽에서 별도 채널(PUBLIC_STOCK_CHANNEL_ID)에
   Container UI로 보내도록 분리함.
   🔧 [수정] 기존엔 _prevUsdtKrw가 단순 메모리 변수라 Railway 재시작마다
   초기화되어, 재배포가 잦으면 입고가 있어도 "새 기준값"으로만 조용히
   흡수되고 알림이 거의 안 뜨는 문제가 있었음. db.js의 config 테이블에
   기준값을 저장해서 재시작에도 이어지도록 함(이벤트로그 백업으로 자동 복구됨).
============================================================ */
let _prevUsdtKrw = null;
let _prevUsdtKrwLoaded = false;

export async function checkAndNotifyRestock(client, onRestock) {
  try {
    // 최초 1회만 DB에서 마지막 기준값을 불러옴 (그 이후엔 메모리 값 사용)
    if (!_prevUsdtKrwLoaded) {
      const stored = getConfig("prev_usdt_krw");
      _prevUsdtKrw = stored !== null ? parseFloat(stored) : null;
      _prevUsdtKrwLoaded = true;
    }

    const b = await getBalancesKRW();
    console.log(`[재고체크] 현재 USDT잔고: ₩${Math.round(b.usdtKrw).toLocaleString()} / 기준값: ${_prevUsdtKrw === null ? "없음(최초)" : "₩" + Math.round(_prevUsdtKrw).toLocaleString()}`);

    if (_prevUsdtKrw === null) {
      _prevUsdtKrw = b.usdtKrw;
      setConfig("prev_usdt_krw", b.usdtKrw); // 최초 기준값은 반드시 영속화
      console.log("[재고체크] 최초 실행 - 기준값만 설정하고 이번엔 알림 없이 넘어감");
      return;
    }

    const diff = Math.round(b.usdtKrw - _prevUsdtKrw);
    console.log(`[재고체크] 차이: ${diff >= 0 ? "+" : ""}₩${diff.toLocaleString()} (임계값: 1,000원 이상일 때 알림)`);
    if (diff >= 10000) {
      const ch = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
      if (ch) await ch.send(`📦 MEXC USDT 입고 감지: +₩${diff.toLocaleString()} (총 ₩${Math.round(b.usdtKrw).toLocaleString()})`);

      if (typeof onRestock === "function") {
        await onRestock(diff, Math.round(b.usdtKrw));
      }
      setConfig("prev_usdt_krw", b.usdtKrw); // 실제 입고가 감지된 시점의 기준값만 영속화 (매 tick 로그 스팸 방지)
    }

    _prevUsdtKrw = b.usdtKrw; // 메모리상의 기준값은 매 tick마다 갱신
  } catch (e) { console.error("입고 알림 체크 실패:", e.message); }
}


