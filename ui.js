import {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";

/* ============================================================
   공통 상수
============================================================ */

export const COIN_COLORS = {
  BNB:     0xF0B90B,
  USDTBSC: 0x26A17B,
  TRX:     0xFF0013,
  LTC:     0xA6A9AA,
  SOL:     0x9945FF,
};

export const CHAIN_MAP = {
  BNB: "BSC", USDTBSC: "BSC", TRX: "TRX", LTC: "LTC", SOL: "SOL",
};

/**
 * 내부적으로는 "USDTBSC" 같은 코드를 쓰지만, 화면에는 그냥 "USDT"로 보여줌.
 * (wallet.js 등 백엔드 로직은 그대로 "USDTBSC" 코드를 사용해야 하므로 값 자체는 안 바꿈)
 */
const COIN_DISPLAY_NAMES = { USDTBSC: "USDT" };
function displayCoin(coin) {
  return COIN_DISPLAY_NAMES[coin] ?? coin;
}

/* ============================================================
   메인 패널 상태
============================================================ */

let _lastUpdated = null;

export async function buildMainContainer() {
  let totalKrw = 0, btcKimp = null, failed = false;
  try {
    const { getBalancesKRW } = await import("./wallet.js");
    const b  = await getBalancesKRW();
    totalKrw = Math.round(b.totalKrw);
    btcKimp  = b.rates.btcKimp;
  } catch { failed = true; }

  // 갱신 시각: 디스코드 타임스탬프 포맷 사용
  // <t:UNIX:t> = 짧은 시각(유저 시간대 자동 반영), <t:UNIX:R> = "n분 전" 자동 실시간 갱신
  const ts = Math.floor(Date.now() / 1000);

  const kimpStr  = failed || btcKimp === null ? "조회 실패" : `${btcKimp >= 0 ? "+" : ""}${btcKimp.toFixed(2)}%`;
  const stockStr = failed ? "조회 실패" : `${totalKrw.toLocaleString()}원`;

  return [
    new ContainerBuilder()
    .setAccentColor(3066993)
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("# BITONE"),
    )
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# **비트원**에 오신것을 환영합니다!"),
    )
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**실시간 재고**\n> **\`${stockStr}\`**`),
    )
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**실시간 김프**\n> **\`${kimpStr}\`**`),
    )
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# <t:${ts}:t>에 갱신됨 (<t:${ts}:R>)`),
    )
    .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addActionRowComponents(
        new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("충전")
                    .setCustomId("charge_open"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("송금")
                    .setCustomId("send_open_select"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("내 정보")
                    .setCustomId("user_info_open"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("계산기")
                    .setCustomId("calc_open"),
            ),
    ),
  ];
}

export function uiBlacklisted() {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:Barrier:1523156080132231369> 이용이 제한되었습니다"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "블랙리스트에 등록된 계정입니다.\n문의사항은 관리자에게 문의해주세요."
    ));
}

export function uiBlacklistUpdated(action, userId, reason) {
  const titleMap = {
    "추가": "## ⛔ 블랙리스트 추가 완료",
    "삭제": "## ✅ 블랙리스트 해제 완료",
    "없음": "## ℹ️ 블랙리스트에 없는 유저입니다",
  };
  return new ContainerBuilder()
    .setAccentColor(action === "삭제" ? 0x57F287 : action === "없음" ? 0xB0C4FF : 0xED4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(titleMap[action] ?? "## 블랙리스트"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**대상:** <@${userId}>\n` + (action === "추가" ? `**사유:** ${reason}` : "")
    ));
}

export function uiBlacklistInfo(user, entry) {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🔍 블랙리스트 조회"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      entry
        ? `**대상:** ${user}\n**사유:** ${entry.reason}\n**등록자:** ${entry.added_by}\n**등록일시:** ${new Date(entry.added_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
        : `**대상:** ${user}\n블랙리스트에 등록되어 있지 않습니다.`
    ));
}

export function uiManualVerifyDone(userId, realName) {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ✅ 수동 인증 완료"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**대상:** <@${userId}>\n**이름:** ${realName}\n-# 관리자에 의해 수동으로 인증 처리되었습니다.`
    ));
}

export function uiManualChargeDone(userId, amount, newBalance) {
  return new ContainerBuilder()
    .setAccentColor(amount >= 0 ? 0xffffff : 15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ✅ 잔액 조정 완료"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**대상:** <@${userId}>\n**조정 금액:** ${amount >= 0 ? "+" : ""}${amount.toLocaleString()}원\n**현재 잔액:** ${newBalance.toLocaleString()}원`
    ));
}

/**
 * 공개 채널(PUBLIC_LOG_CHANNEL_ID)용 구매 감사 컨테이너
 */
export function uiPurchaseThanks({ userId, coin, coinAmount, krw }) {
  return new ContainerBuilder()
    .setAccentColor(16446708)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### <a:e_1:1523192758674788562> 대행로그"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# **<@${userId}>님, 오늘도 저희 비트원 코인 송금 대행을 이용해 주셔서 감사합니다.**`
    ))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**이용금액**"))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**\`\`\`${krw.toLocaleString()}원\`\`\`**`));
}

/**
 * 공개 재고입고 알림 (PUBLIC_STOCK_CHANNEL_ID로 발송, 구매감사 로그와는 다른 채널)
 */
export function uiStockRestockAlert(diffKrw) {
  const roleId = process.env.STOCK_ROLE_ID;
  const roleMention = roleId ? `<@&${roleId}>` : "@재고역할";
  const clockStr = new Date().toLocaleTimeString("en-US", {
    timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit", hour12: true,
  }).replace(" ", "");

  return new ContainerBuilder()
    .setAccentColor(16448763)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## <a:Lightning:1523630284325781525>${roleMention}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**\`\`\`${diffKrw.toLocaleString()}원이 입고 되었습니다.\`\`\`**`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# **${clockStr}**`));
}

export function uiAdjustTotalSpentDone(userId, amount, newTotal) {
  return new ContainerBuilder()
    .setAccentColor(amount >= 0 ? 3066993 : 15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ✅ 누적송금 조정 완료"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**대상:** <@${userId}>\n**조정액:** ${amount >= 0 ? "+" : ""}${amount.toLocaleString()}원\n**새 누적송금:** ${newTotal.toLocaleString()}원`
    ));
}

export function uiLimitAdjusted(userId, limit, isReset) {
  return new ContainerBuilder()
    .setAccentColor(3066993)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(isReset ? "## ✅ 일일한도 초기화 완료" : "## ✅ 일일한도 조정 완료"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      isReset
        ? `**대상:** <@${userId}>\n기본 한도(${limit.toLocaleString()}원)로 초기화되었습니다.`
        : `**대상:** <@${userId}>\n**새 일일한도:** ${limit.toLocaleString()}원`
    ));
}

export function uiNoPermission() {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:Barrier:1523156080132231369> 권한이 없습니다"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "이 기능은 **관리자만** 사용할 수 있습니다."
    ));
}

/* ============================================================
   점검 / 인증
============================================================ */

export function uiMaintenance() {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:Barrier:1523156080132231369> 긴급 점검 중"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "현재 서비스 점검 중입니다.\n빠른 시간 내에 복구하겠습니다.\n\n-# 이용에 불편을 드려 죄송합니다."
    ));
}

export function uiMaintenanceToggle(isOn) {
  return new ContainerBuilder()
    .setAccentColor(isOn ? 0xFF4500 : 0x57F287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      isOn ? "## 🔧 긴급 점검 ON" : "## ✅ 점검 해제"
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      isOn
        ? "긴급 점검 모드가 활성화되었습니다.\n모든 유저의 버튼/메뉴가 차단됩니다."
        : "점검이 해제되었습니다.\n서비스가 정상 운영됩니다."
    ));
}

export function uiVerify() {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 본인인증"))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "**서비스 이용을 위해 본인인증이 필요합니다.**\n아래에서 통신사를 선택하세요."
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(false))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("telecom_SKT").setLabel("SKT").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("telecom_KT").setLabel("KT").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("telecom_LG").setLabel("LG U+").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("telecom_MVNO").setLabel("알뜰폰").setStyle(ButtonStyle.Primary).setDisabled(true),
    ));
}

/* ============================================================
   송금 플로우
============================================================ */

export function uiCoinSelect() {
  return new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 코인 선택"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**송금할 코인을 선택해주세요.**"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("send_select_coin").setPlaceholder("코인을 선택하세요")
        .addOptions(
          { label: "Binancecoin",  description: "BNB",  value: "BNB",     emoji: "<:BNB:1485581565873487954>" },
          { label: "TetherUSD",    description: "USDT", value: "USDTBSC", emoji: "<:USDT:1485581569245581344>" },
          { label: "Litecoin",     description: "LTC",  value: "LTC",     emoji: "<:Litecoin1:1485581687453646890>" },
          { label: "TRON",         description: "TRX",  value: "TRX",     emoji: "<:TRX:1485581567786090527>" },
          { label: "Solana",       description: "SOL",  value: "SOL",     emoji: "<:sol:1498294613939851415>" },
        )
    ));
}

export function uiNetworkSelect(coin) {
  const NETWORKS = {
    BNB:     [{ label: "BNB Smart Chain (BSC)", value: "BNB",     emoji: "<:BNB:1490243194846449754>" }],
    USDTBSC: [{ label: "BNB Smart Chain (BSC)", value: "USDTBSC", emoji: "<:BNB:1490243194846449754>" }],
    TRX:     [{ label: "TRON (TRX)",            value: "TRX",     emoji: "<:TRX:1485581567786090527>" }],
    LTC:     [{ label: "Litecoin (LTC)",         value: "LTC",     emoji: "<:Litecoin1:1485581687453646890>" }],
    SOL:     [{ label: "Solana (SOL)",           value: "SOL",     emoji: "<:sol:1498294613939851415>" }],
  };

  const networkOptions = NETWORKS[coin];
  if (!networkOptions) {
    return new ContainerBuilder()
      .setAccentColor(0xffffff)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `## <a:ExclamationMark:1523117077261455501> 지원하지 않는 코인입니다.\n\`${coin}\``
      ));
  }

  return new ContainerBuilder()
    .setAccentColor(0xFfffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 네트워크 선택"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${displayCoin(coin)} 의 네트워크를 선택해주세요.**`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("send_select_network")
        .setPlaceholder("네트워크를 선택하세요")
        .addOptions(networkOptions)
    ));
}

export function uiInsufficientPoints(krw, balance) {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:ExclamationMark:1523117077261455501> 잔액 부족"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**요청 금액:** ${krw.toLocaleString()}원\n` +
      `**현재 잔액:** ${balance.toLocaleString()}원\n` +
      `-# 충전 후 다시 시도해주세요.`
    ));
}

export function uiDailyLimitExceeded(dailySpent, krw, limit) {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:ExclamationMark:1523117077261455501> 일일 한도 초과"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**오늘 송금:** ${dailySpent.toLocaleString()}원\n` +
      `**요청 금액:** ${krw.toLocaleString()}원\n` +
      `**일일 한도:** ${limit.toLocaleString()}원\n` +
      `-# 자정 이후 다시 시도해주세요.`
    ));
}

export function uiSendConfirm({ coin, address, krw, feeKrw, feePercent, actualKrw, coinAmount, rates }) {
  return new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📋 송금 확인"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**코인:** ${displayCoin(coin)}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**받는 주소**\n\`${address}\``))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**요청 금액:** ${krw.toLocaleString()}원\n` +
      `**수수료 (5.5% + 김프):** -${feeKrw.toLocaleString()}원\n` +
      `**실제 송금:** ${actualKrw.toLocaleString()}원 → **${coinAmount.toFixed(6)} ${displayCoin(coin)}**\n` +
      `> 1 ${displayCoin(coin)} = ₩${Math.round(rates[coin]).toLocaleString()}`
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("send_confirm").setLabel("✅ 송금").setStyle(ButtonStyle.Success),
    ));
}

export function uiSendComplete({ coin, coinAmount, krw, address, result }) {
  const network = CHAIN_MAP[coin] ?? coin;
  const kstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const timeStr = `${kstNow.getHours()}시 ${kstNow.getMinutes().toString().padStart(2, "0")}분`;

  const container = new ContainerBuilder()
    .setAccentColor(1291094)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:check:1523616950863925258>송금이 완료되었어요."))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**금액 : \`${krw.toLocaleString()}원\`**\n` +
      `**코인 : \`${displayCoin(coin)}\`**\n` +
      `**네트워크 : \`${network}\`**\n` +
      `**주소 : \`${address}\`**\n` +
      `**출금일시 : \`${timeStr}\`**`
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# **오늘도 BITONE을 이용해주셔서 감사합니다.**"));

  if (result?.explorer) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🔗 TXID 확인하기").setURL(result.explorer)
    ));
  }

  return container;
}

export function uiSendFail(errMessage) {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:ExclamationMark:1523117077261455501> 송금 실패"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**오류:** \`${errMessage}\`\n-# 잔액이 환불되었습니다.`
    ));
}

/* ============================================================
   내 정보
============================================================ */

/**
 * 등급/역할 안내 (누적 송금액 기준 자동 역할 부여 12단계)
 */
export function uiGradeInfo() {
  const lines = [
    "**",
    "<@&1523182081906315414>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +20,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523181735486165022>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +15,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523181324184322132>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +10,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523180335322632202>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +8,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523180037791289374>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +5,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523179745385119784>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +4,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523179433958051961>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +3,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523179067690455141>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +2,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523178341492854914>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +1,000,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523177478577848350>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +500,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523176786681139230>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +100,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "<@&1523174407835484311>",
    "<a:arrow_arrow:1523190711586001025> 누적 금액 +10,000원",
    "<a:arrow_arrow:1523190711586001025> 매입 수수료 -5%",
    "<a:arrow_arrow:1523190711586001025> 대행 수수료 5.5%",
    "**",
  ];

  const footer =
    "**<a:e_1:1523192758674788562> 현재 모든 역할등급 `수수료율`은 모두 동일합니다.\n" +
    "<@&1523180335322632202> 등급 이상부턴 `전용라운지`가 제공됩니다.**";

  return new ContainerBuilder()
    .setAccentColor(2067276)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🏅 등급 및 역할 안내"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
}

export function uiMyInfo({ user, grade, points, spent, dailySpent, dailyLimit, history }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${user.username} 정보`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `잔액: **${points.toLocaleString()}원**\n` +
      `누적송금: **${spent.toLocaleString()}원**\n` +
      `등급: **${grade?.name ?? "일반"}**\n` +
      `일일한도: **${(dailySpent ?? 0).toLocaleString()} / ${(dailyLimit ?? 200000).toLocaleString()}원**`
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("grade_info_open").setLabel("🏅 등급 안내").setStyle(ButtonStyle.Secondary)
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 송금 내역"));

  const list = history ?? [];
  if (list.length > 0) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("info_history_select")
          .setPlaceholder("송금내역 보기")
          .addOptions(list.map((h, i) => ({
            label: `${i + 1}. ${displayCoin(h.coin)} ${h.amount.toFixed(4)} (${h.krw.toLocaleString()}원)`,
            description: new Date(h.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
            value: String(h.id),
          })))
      )
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 송금 내역이 없습니다.")
    );
  }
  return container;
}

export function uiHistoryDetail(row) {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📄 송금 상세 내역"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**코인:** ${displayCoin(row.coin)}\n` +
      `**송금액:** ${row.amount.toFixed(6)} ${displayCoin(row.coin)} (${row.krw.toLocaleString()}원)\n` +
      `**받는 주소:** \`${row.address}\`\n` +
      `**TX Hash:** \`${row.hash}\`\n` +
      `**일시:** ${new Date(row.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
    ));
}

/* ============================================================
   충전
============================================================ */

export function uiChargeCreated(ticketChannel) {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 충전 티켓 생성 완료"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${ticketChannel} 채널이 생성되었습니다.\n잠시만 기다려주세요.`
    ));
}

export function uiChargeTicket(userId, username, amount) {
  return new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 💳 충전 신청"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**사용자:** <@${userId}>\n**성명:** ${username}\n**충전 금액:** ${amount.toLocaleString()}원`
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`charge_approve_${userId}_${amount}`).setLabel("✅ 충전 승인").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`charge_reject_${userId}_${amount}`).setLabel("❌ 충전 거절").setStyle(ButtonStyle.Danger),
    ));
}

export function uiChargeApproved(userId, amount, processorTag) {
  return new ContainerBuilder()
    .setAccentColor(3066993)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:check:1523616787730661486> 충전 승인 완료"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `<@${userId}> 님의 **${amount.toLocaleString()}원** 충전이 승인되었습니다.\n-# 처리자: ${processorTag}`
    ));
}

export function uiBalanceAdjustedDM(amount, newBalance) {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🔧 잔액 조정 안내"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `관리자에 의해 잔액이 조정되었습니다.\n**조정 금액:** ${amount >= 0 ? "+" : ""}${amount.toLocaleString()}원\n**현재 잔액:** ${newBalance.toLocaleString()}원`
    ));
}

export function uiChargeApprovedDM(amount, currentPoints) {
  return new ContainerBuilder()
    .setAccentColor(3066993)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:check:1523616787730661486> 충전 승인"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${amount.toLocaleString()}원** 충전이 승인되었습니다!\n현재 잔액: **${currentPoints.toLocaleString()}원**`
    ));
}

export function uiChargeRejected(userId, amount, processorTag) {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:ExclamationMark:1523117077261455501> 충전 거절"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `<@${userId}> 님의 **${amount.toLocaleString()}원** 충전이 거절되었습니다.\n-# 처리자: ${processorTag}`
    ));
}

export function uiChargeRejectedDM(amount) {
  return new ContainerBuilder()
    .setAccentColor(15158332)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## <a:ExclamationMark:1523117077261455501> 충전 거절"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${amount.toLocaleString()}원** 충전 신청이 거절되었습니다.\n문의사항은 관리자에게 문의해주세요.`
    ));
}

/* ============================================================
   등급 달성 DM
============================================================ */

export function uiGradeUp(grade) {
  return new ContainerBuilder()
    .setAccentColor(grade.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${grade.emoji} 등급 달성!`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${grade.name}** 등급을 달성했습니다!\n역할이 자동으로 지급되었어요.`
    ));
}

/* ============================================================
   관리자 커맨드
============================================================ */

export function uiAdminInfo(row, grade, points, spent) {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🔍 유저 정보 조회"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**디스코드 ID:** ${row.discord_id}\n` +
      `**실명:** ${row.real_name}\n` +
      `**생년월일:** ${row.birthday}\n` +
      `**전화번호:** ${row.phone}\n` +
      `**통신사:** ${row.telecom}\n` +
      `**등급:** ${grade.emoji} ${grade.name}\n` +
      `**잔액:** ${points.toLocaleString()}원\n` +
      `**누적 송금:** ${spent.toLocaleString()}원\n` +
      `**인증일시:** ${new Date(row.verified_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
    ));
}

export function uiStockInfo(b) {
  const fmt = (krw) => `₩${Math.round(krw).toLocaleString()}`;
  const now  = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const text =
    `**LTC** : \`${b.ltcBal.toFixed(6)} LTC\` (${fmt(b.ltcKrw)})\n` +
    `**TRX** : \`${b.trxBal.toFixed(2)} TRX\` (${fmt(b.trxKrw)})\n` +
    `**BNB** : \`${b.bnbBal.toFixed(6)} BNB\` (${fmt(b.bnbKrw)})\n` +
    `**USDT**: \`${b.usdtBal.toFixed(2)} USDT\` (${fmt(b.usdtKrw)})\n` +
    `**SOL** : \`${b.solBal.toFixed(6)} SOL\` (${fmt(b.solKrw)})\n` +
    `\n**총 재고**: ${fmt(b.totalKrw)}`;
  return new ContainerBuilder()
    .setAccentColor(0xB0C4FF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📦 재고 현황"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 조회 시각: ${now}`));
}

/* ============================================================
   계산기 (수수료 계산 / 역산 필요 잔액)
============================================================ */
export function uiCalcCoinSelect() {
  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 송금 계산기"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**계산할 코인을 선택해주세요.**"))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("calc_select_coin").setPlaceholder("코인을 선택하세요")
        .addOptions(
          { label: "Binancecoin",  description: "BNB",        value: "BNB",     emoji: "<:BNB:1485581565873487954>" },
          { label: "TetherUSD",    description: "USDT",       value: "USDTBSC", emoji: "<:USDT:1485581569245581344>" },
          { label: "Litecoin",     description: "LTC",        value: "LTC",     emoji: "<:Litecoin1:1485581687453646890>" },
          { label: "TRON",         description: "TRX",        value: "TRX",     emoji: "<:TRX:1485581567786090527>" },
          { label: "Solana",       description: "SOL",        value: "SOL",     emoji: "<:sol:1498294613939851415>" },
        )
    ));
}

/**
 * 계산 결과 표시
 */
export function uiCalcResult({ coin, krw, feeKrw, feePercent, receivedKrw, coinPrice, coinAmount, totalNeeded, extraNeeded }) {
  const priceStr = coinPrice > 0 ? `₩${Math.round(coinPrice).toLocaleString()}` : "조회 실패";
  const coinAmountStr = coinPrice > 0 ? `${coinAmount.toFixed(6)} ${displayCoin(coin)}` : "조회 실패";

  return new ContainerBuilder()
    .setAccentColor(0xffffff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${displayCoin(coin)} 송금 계산 결과`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**입력 금액:** ${krw.toLocaleString()}원\n` +
      `**수수료 (5.5% + 김프):** -${feeKrw.toLocaleString()}원\n` +
      `**송금받을 금액:** ${receivedKrw.toLocaleString()}원 → **${coinAmountStr}**\n` +
      `-# 1 ${displayCoin(coin)} ≈ ${priceStr} (Binance 시세 · 실시간 환율 기준)`
    ))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${krw.toLocaleString()}원을 그대로 받으시려면?**\n` +
      `필요한 총 잔액: **${totalNeeded.toLocaleString()}원**\n` +
      `추가로 필요한 잔액: **+${extraNeeded.toLocaleString()}원**`
    ));
}