import crypto from "crypto";
import axios from "axios";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

import { 
  handleInteraction, updateStockMessage, restoreStockMessage, 
  notifyPublicRestock, addBlacklist, removeBlacklist, startPushbulletStream 
} from "./handlers.js";

import { checkAndNotifyRestock } from "./wallet.js";
import { restoreFromEventLog } from "./dbBackup.js";
import { setClient } from "./dbEventLog.js";

/* ============================================================
   환경변수 및 채널 설정
============================================================ */
const BALANCE_CHANNEL_ID = "1529147114087514112";
const KIMP_CHANNEL_ID = "1529794086620369038";

const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_SECRET_KEY = process.env.MEXC_API_SECRET;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // 디스코드 봇 토큰

// 봇/API 차단 방지를 위한 커스텀 Axios 인스턴스
const http = axios.create({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  },
  timeout: 10000
});

/* ============================================================
   봇 초기화
============================================================ */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ============================================================
   슬래시 커맨드 (이전과 동일)
============================================================ */
const COMMANDS = [
  new SlashCommandBuilder()
    .setName("송금")
    .setDescription("BITKNIGHT 송금 패널 (관리자 전용)")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("정보조회")
    .setDescription("인증된 유저 정보 조회 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("점검")
    .setDescription("긴급 점검 모드 ON/OFF (관리자 전용)")
    .addStringOption(o =>
      o.setName("상태").setDescription("on 또는 off").setRequired(true)
        .addChoices({ name: "ON", value: "on" }, { name: "OFF", value: "off" })
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("재고현황")
    .setDescription("현재 지갑 재고 현황 조회 (관리자 전용)")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("수동인증")
    .setDescription("유저를 수동으로 인증 처리합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addStringOption(o => o.setName("이름").setDescription("실명").setRequired(true))
    .addStringOption(o => o.setName("생년월일").setDescription("생년월일 (예: 990101)").setRequired(true))
    .addStringOption(o => o.setName("전화번호").setDescription("전화번호 (예: 01012345678)").setRequired(true))
    .addStringOption(o =>
      o.setName("통신사").setDescription("통신사").setRequired(true)
        .addChoices(
          { name: "SKT", value: "SKT" },
          { name: "KT", value: "KT" },
          { name: "LG U+", value: "LG" },
          { name: "알뜰폰", value: "MVNO" },
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("블랙리스트")
    .setDescription("블랙리스트를 관리합니다 (관리자 전용)")
    .addStringOption(o =>
      o.setName("동작").setDescription("추가/삭제/조회").setRequired(true)
        .addChoices(
          { name: "추가", value: "추가" },
          { name: "삭제", value: "삭제" },
          { name: "조회", value: "조회" },
        )
    )
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addStringOption(o => o.setName("사유").setDescription("사유 (추가 시)").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("잔액조정")
    .setDescription("특정 유저의 잔액을 수동으로 조정합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("조정할 금액(원, 음수 가능)").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("누적송금조정")
    .setDescription("유저의 누적 송금액을 수동으로 조정합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("조정할 금액(원, 음수 가능)").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("한도조정")
    .setDescription("유저의 일일 송금 한도를 조정합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addIntegerOption(o => o.setName("한도").setDescription("새 일일한도(원). 생략하면 기본값으로 초기화").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("자동충전한도")
    .setDescription("자동 충전 1회 최대 한도를 설정합니다 (관리자 전용)")
    .addUserOption(o => o.setName("유저").setDescription("한도를 설정할 유저 (생략 시 전체 기본값 변경)").setRequired(false))
    .addIntegerOption(o => o.setName("금액").setDescription("설정할 한도 금액(원). 유저 지정 시 생략하면 초기화").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("수익통계")
    .setDescription("기간별 수수료 수익 통계를 조회합니다 (관리자 전용)")
    .toJSON(),
];

/* ============================================================
   채널 이름 갱신 기능 (환율/BTC 김프/잔액)
============================================================ */
async function updateChannels(client) {
  try {
    // 1. 환율, 업비트(BTC, USDT 모두), MEXC 시세 병렬 조회
    const [fxRes, upbitRes, tickerRes] = await Promise.all([
      http.get("https://open.er-api.com/v6/latest/USD"),
      http.get("https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-USDT"), // 수정됨: BTC와 USDT 두 개를 가져옴
      http.get("https://api.mexc.com/api/v3/ticker/price")
    ]);

    const usdKrw = fxRes.data.rates.KRW;

    // 업비트 응답에서 BTC와 USDT 가격 각각 파싱
    let upbitBtcKrw = 0;
    let upbitUsdtKrw = 0;
    for (const item of upbitRes.data) {
      if (item.market === "KRW-BTC") upbitBtcKrw = item.trade_price;
      if (item.market === "KRW-USDT") upbitUsdtKrw = item.trade_price;
    }

    // MEXC 전체 시세 Map 정리
    const priceMap = new Map();
    for (const item of tickerRes.data) {
      priceMap.set(item.symbol, Number(item.price));
    }

    // 수정됨: BTC 기준 김프 계산
    const mexcBtcUsdt = priceMap.get("BTCUSDT"); // MEXC의 비트코인 가격 (USDT)
    const globalBtcKrw = mexcBtcUsdt * usdKrw; // 글로벌 비트코인 가격을 원화로 환산
    const kimp = ((upbitBtcKrw / globalBtcKrw) - 1) * 100;

    // 2. MEXC Spot 잔액 조회
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;

    const signature = crypto
      .createHmac("sha256", MEXC_SECRET_KEY)
      .update(query)
      .digest("hex");

    const { data: account } = await http.get(
      `https://api.mexc.com/api/v3/account?${query}&signature=${signature}`,
      {
        headers: {
          "X-MEXC-APIKEY": MEXC_API_KEY,
        },
      }
    );

    // 3. 전체 자산 USDT 환산
    let totalUSDT = 0;

    for (const asset of account.balances) {
      const amount = Number(asset.free) + Number(asset.locked);
      if (amount <= 0) continue;

      if (asset.asset === "USDT") {
        totalUSDT += amount;
        continue;
      }

      const symbol = `${asset.asset}USDT`;
      const price = priceMap.get(symbol);

      if (price) {
        totalUSDT += amount * price;
      }
    }

    // 4. 자산 KRW 계산 (현금화 가치를 위해 업비트 USDT 가격 적용)
    const totalKRW = Math.round(totalUSDT * upbitUsdtKrw);

    // 5. 디스코드 채널 fetching & 이름 비교 갱신
    const balanceChannel = await client.channels.fetch(BALANCE_CHANNEL_ID);
    const kimpChannel = await client.channels.fetch(KIMP_CHANNEL_ID);

    const newBalanceName = `재고: ${totalKRW.toLocaleString()}원`;
    const newKimpName = `📈ㆍ${kimp >= 0 ? "+" : ""}${kimp.toFixed(2)}%`;

    // 변경사항이 있을 때만 API 호출 (Rate Limit 방지)
    const updatePromises = [];
    if (balanceChannel && balanceChannel.name !== newBalanceName) {
      updatePromises.push(balanceChannel.setName(newBalanceName));
    }
    if (kimpChannel && kimpChannel.name !== newKimpName) {
      updatePromises.push(kimpChannel.setName(newKimpName));
    }

    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
      console.log(`[채널 갱신 완료] ${newBalanceName} | ${newKimpName}`);
    } else {
      console.log(`[변동 없음] 기존 채널명 유지 중...`);
    }

  } catch (err) {
    console.error("[채널 갱신 실패]", err.response?.data || err.message);
  }
}

/* ============================================================
   이벤트 설정 및 로그인
============================================================ */
client.once("ready", async () => {
  console.log(`✅ 봇 로그인 성공: ${client.user.tag}`);

  // 이 시점부터 db.js의 모든 변경사항이 백업채널에 실시간으로 기록됨
  setClient(client);

  // DB 복원
  await restoreFromEventLog(client, { addBlacklist, removeBlacklist });

  // 슬래시 커맨드 등록
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
  console.log("✅ 슬래시 커맨드 등록 완료");

  // DB에서 이전 송금 패널 메시지 복구 및 루프
  await restoreStockMessage(client);
  setInterval(updateStockMessage, 610_000); // 약 10분 10초
  
  // 재고 현황 체크 및 루프
  const runRestockCheck = () => checkAndNotifyRestock(client, (diffKrw) => notifyPublicRestock(client, diffKrw));
  await runRestockCheck();
  setInterval(runRestockCheck, 60_000); // 약 10분 10초

  // 💡 자동 충전 시스템(Pushbullet) 웹소켓 연결 시작
  startPushbulletStream(client);

  // 💡 채널 이름 자동 갱신 (잔액, 김프) 시작 및 루프
  await updateChannels(client);
  setInterval(() => {
    updateChannels(client);
  }, 630_000); // 10분 30초

  // 봇 상호작용(버튼, 명령어 등) 핸들러
  client.on("interactionCreate", (interaction) => handleInteraction(interaction));
});

// 봇 로그인 실행
client.login(DISCORD_TOKEN);
