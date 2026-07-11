import {
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ChannelType, PermissionFlagsBits, MessageFlags,
} from "discord.js";
import { ethers } from "ethers";

import {
  db, isVerified, getVerifiedInfo, addVerifiedNice,
  getPoints, addPoints, deductPoints, getTotalSpent, adjustTotalSpent, getSendHistory,
  getDailySpent, checkDailyLimit, DAILY_LIMIT, getDailyLimitFor, setDailyLimitFor, resetDailyLimitFor,
  getGrade, GRADE_TIERS, getNotifiedGrade, setNotifiedGrade, recordSend,
  getConfig, setConfig,
} from "./db.js";
import { getRates, processSwapTransfer, sendLog, getBalancesKRW, getCalcCoinKrwPrice } from "./wallet.js";
import { logDbEvent } from "./dbEventLog.js";
import { handleTelecomButton, handleStartInputButton, handleCodeInputButton, handleInfoModal, handleCodeModal } from "./nice.js";
import {
  buildMainContainer, uiMaintenance, uiMaintenanceToggle, uiVerify,
  uiCoinSelect, uiNetworkSelect, uiInsufficientPoints, uiDailyLimitExceeded,
  uiSendConfirm, uiSendComplete, uiSendFail, uiMyInfo, uiHistoryDetail,
  uiChargeCreated, uiChargeTicket, uiChargeApproved, uiChargeApprovedDM,
  uiChargeRejected, uiChargeRejectedDM, uiGradeUp,
  uiAdminInfo, uiStockInfo, uiCalcCoinSelect, uiCalcResult, uiNoPermission,
  uiBlacklisted, uiBlacklistUpdated, uiBlacklistInfo, uiManualChargeDone, uiManualVerifyDone,
  uiPurchaseThanks, uiStockRestockAlert, uiGradeInfo, uiAdjustTotalSpentDone, uiLimitAdjusted,
  uiBalanceAdjustedDM,
} from "./ui.js";

/* ============================================================
   블랙리스트
   기존 db.js를 건드리지 않고, 이미 공유 중인 better-sqlite3 커넥션(db)
   위에 별도 테이블을 두어 독립적으로 관리함.
   🔧 이벤트 로그(dbEventLog)를 통해 백업채널에도 기록되고, 복구 시 재생됨.
============================================================ */
db.exec(`
  CREATE TABLE IF NOT EXISTS blacklist (
    discord_id TEXT PRIMARY KEY,
    reason     TEXT,
    added_by   TEXT,
    added_at   INTEGER
  )
`);

function isBlacklisted(userId) {
  return !!db.prepare("SELECT 1 FROM blacklist WHERE discord_id = ?").get(userId);
}

function getBlacklistEntry(userId) {
  return db.prepare("SELECT * FROM blacklist WHERE discord_id = ?").get(userId);
}

export function addBlacklist(userId, reason, adminTag) {
  db.prepare(
    "INSERT OR REPLACE INTO blacklist (discord_id, reason, added_by, added_at) VALUES (?, ?, ?, ?)"
  ).run(userId, reason, adminTag, Date.now());
  logDbEvent("BLACKLIST_ADD", { discordId: userId, reason, adminTag });
}

export function removeBlacklist(userId) {
  const info = db.prepare("DELETE FROM blacklist WHERE discord_id = ?").run(userId);
  if (info.changes > 0) logDbEvent("BLACKLIST_REMOVE", { discordId: userId });
  return info.changes > 0;
}

/**
 * 충전 티켓 채널 보관 처리
 * 삭제 대신 지정된 "삭제보관" 카테고리로 이동시키고, 신청자의 발언 권한을 제거함.
 * .env에 TICKET_ARCHIVE_CATEGORY_ID가 없으면 안전하게 기존처럼 삭제로 폴백.
 */
async function archiveTicketChannel(channel, ticketUserId) {
  const archiveCategoryId = process.env.TICKET_ARCHIVE_CATEGORY_ID;

  if (!archiveCategoryId) {
    console.warn("TICKET_ARCHIVE_CATEGORY_ID가 설정되지 않아 티켓을 삭제로 대체 처리합니다.");
    return channel.delete().catch(() => {});
  }

  try {
    await channel.setParent(archiveCategoryId, { lockPermissions: false });
    if (ticketUserId) {
      await channel.permissionOverwrites.edit(ticketUserId, {
        SendMessages: false,
      }).catch(() => {});
    }
    if (!channel.name.startsWith("closed-")) {
      await channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => {});
    }
  } catch (e) {
    console.error("티켓 보관 처리 실패:", e.message);
  }
}

/**
 * 관리자 판별: 서버의 "관리자" 권한(역할) 대신, .env의 ADMIN_USER_IDS에
 * 등록된 특정 디스코드 유저 ID로만 관리자 여부를 판단함.
 * .env 예시: ADMIN_USER_IDS=111111111111111111,222222222222222222
 */
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
);

function isAdmin(userId) {
  return ADMIN_USER_IDS.has(userId);
}

/**
 * "유저" 옵션은 문자열(String) 타입이라, 관리자가 @멘션 자동완성으로 입력하면
 * 실제 값이 "<@1234567890>" 형태로 들어와 순수 ID("1234567890")와
 * 일치하지 않는 문제가 있었음. 멘션 형식이면 숫자 ID만 추출해서 반환.
 */
function extractUserId(input) {
  if (!input) return input;
  const match = input.trim().match(/^<@!?(\d+)>$/);
  return match ? match[1] : input.trim();
}

/**
 * 공개 재고입고 알림 발송
 * 구매 감사 로그(PUBLIC_LOG_CHANNEL_ID)와는 완전히 다른 채널(PUBLIC_STOCK_CHANNEL_ID)로 보냄.
 * wallet.js의 checkAndNotifyRestock이 입고를 감지하면 콜백으로 이 함수를 호출함.
 */
export async function notifyPublicRestock(client, diffKrw) {
  try {
    const channelId = process.env.PUBLIC_STOCK_CHANNEL_ID;
    if (!channelId) {
      console.warn("PUBLIC_STOCK_CHANNEL_ID가 설정되지 않아 공개 입고알림을 건너뜁니다.");
      return;
    }
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    await ch.send({ components: [uiStockRestockAlert(diffKrw)], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    console.error("공개 입고알림 전송 실패:", e.message);
  }
}

/**
 * 공개 채널(PUBLIC_LOG_CHANNEL_ID)에 구매 감사 컨테이너 발송
 * 관리자 전용 로그(sendLog)와 별개로, 모든 서버원이 볼 수 있는 공개 채널용.
 */
async function sendPublicPurchaseLog(client, { userId, coin, coinAmount, krw }) {
  try {
    const channelId = process.env.PUBLIC_LOG_CHANNEL_ID;
    if (!channelId) {
      console.warn("PUBLIC_LOG_CHANNEL_ID가 설정되지 않아 공개 구매 로그를 건너뜁니다.");
      return;
    }
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    await ch.send({ components: [uiPurchaseThanks({ userId, coin, coinAmount, krw })], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    console.error("공개 구매 로그 전송 실패:", e.message);
  }
}

/* ============================================================
   등급 역할 부여 헬퍼
   🔧 [수정] 기존에는 .env의 ROLE_KNIGHT 등 4단계 역할 매핑을 썼는데,
   이제 db.js의 GRADE_TIERS(12단계, 누적금액 기준)에 역할 ID가 직접
   들어있으므로 grade.roleId를 그대로 사용함.
   🔧 [추가] "등급 달성!" DM이 혹시라도 중복 발송되는 일이 없도록,
   DB에 notified_grade를 기록해두고 이미 알린 등급 이상이면 곧바로
   건너뜀 (member.roles.cache 레이스컨디션에도 안전).
============================================================ */
async function assignGradeRole(guild, userId) {
  const grade = getGrade(getTotalSpent(userId));
  if (!grade.roleId) return null;

  // 이미 이 등급(또는 그 이상)으로 알림을 보낸 적 있으면 스킵
  if (getNotifiedGrade(userId) >= grade.threshold) return null;

  try {
    const member = await guild.members.fetch({ user: userId, force: true });

    // 다른 등급 역할은 제거하고 새 등급 역할만 부여
    const allTierRoleIds = GRADE_TIERS.map(t => t.roleId);
    const toRemove = allTierRoleIds.filter(id => id !== grade.roleId && member.roles.cache.has(id));
    for (const id of toRemove) await member.roles.remove(id).catch(() => {});

    if (!member.roles.cache.has(grade.roleId)) {
      await member.roles.add(grade.roleId);
    }

    // 알림 발송 여부를 즉시 기록해서 이후 중복 호출을 원천 차단
    setNotifiedGrade(userId, grade.threshold);
    return grade;
  } catch { return null; }
}

/* ============================================================
   상태 관리
============================================================ */

export const pendingTransfers = new Map();
const activeSending = new Set();
let _stockMessage   = null;
let _isMaintenance  = getConfig("maintenance") === "true";

export function getStockMessage() { return _stockMessage; }

export function setStockMessage(msg) {
  _stockMessage = msg;
  setConfig("stock_channel_id", msg.channelId);
  setConfig("stock_message_id", msg.id);
}

export async function restoreStockMessage(client) {
  const channelId = getConfig("stock_channel_id");
  const messageId = getConfig("stock_message_id");
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    _stockMessage  = await channel.messages.fetch(messageId);
    console.log("✅ 송금 패널 메시지 복구 완료");
    await updateStockMessage();
  } catch (e) { console.error("송금 패널 복구 실패:", e.message); }
}

export async function updateStockMessage() {
  if (!_stockMessage) return;
  try {
    const components = _isMaintenance ? [uiMaintenance()] : await buildMainContainer();
    await _stockMessage.edit({ components, flags: MessageFlags.IsComponentsV2 });
  } catch (e) { console.error("잔액 갱신 실패:", e.message); }
}

/* ============================================================
   인증 체크
============================================================ */

const ALLOW_WITHOUT_VERIFY = [
  "telecom_SKT","telecom_KT","telecom_LG","telecom_MVNO",
  "telecom_SKM","telecom_KTM","telecom_LGM",
];

function needsVerifyCheck(interaction) {
  if (interaction.isChatInputCommand() || interaction.isModalSubmit()) return false;
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (ALLOW_WITHOUT_VERIFY.includes(id))  return false;
    if (id.startsWith("start_input_"))      return false;
    if (id.startsWith("code_input_"))       return false;
    if (id.startsWith("charge_approve_"))   return false;
    if (id.startsWith("charge_reject_"))    return false;
  }
  return true;
}

/* ============================================================
   메인 핸들러
============================================================ */

export async function handleInteraction(interaction) {
  // 블랙리스트 차단 (관리자 제외) — 명령어/버튼/셀렉트/모달 전부 최우선 차단
  if (isBlacklisted(interaction.user.id) && !isAdmin(interaction.user.id)) {
    const fn = (interaction.deferred || interaction.replied) ? "followUp" : "reply";
    await interaction[fn]({ components: [uiBlacklisted()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isChatInputCommand()) return handleCommand(interaction);

  // 점검 중 차단 (관리자 제외)
  if (_isMaintenance && !isAdmin(interaction.user.id)) {
    const fn = (interaction.deferred || interaction.replied) ? "followUp" : "reply";
    await interaction[fn]({ components: [uiMaintenance()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  // 미인증 차단
  if (needsVerifyCheck(interaction) && !isVerified(interaction.user.id)) {
    const fn = (interaction.deferred || interaction.replied) ? "followUp" : "reply";
    await interaction[fn]({ components: [uiVerify()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isButton())           return handleButton(interaction);
  if (interaction.isStringSelectMenu()) return handleSelect(interaction);
  if (interaction.isModalSubmit())      return handleModal(interaction);
}

/* ============================================================
   슬래시 커맨드
============================================================ */

async function handleCommand(interaction) {
  const { commandName } = interaction;

  // 🔧 모든 슬래시 커맨드는 예외 없이 관리자 전용.
  // 개별 명령어마다 체크를 반복하지 않고 여기서 한 번에 차단해서,
  // 앞으로 새 명령어가 추가돼도 체크를 빠뜨릴 위험이 없게 함.
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ components: [uiNoPermission()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  if (commandName === "송금") {
    const components = await buildMainContainer();
    const msg = await interaction.reply({ components, flags: MessageFlags.IsComponentsV2, fetchReply: true });
    setStockMessage(msg);
    return;
  }

  if (commandName === "점검") {
    _isMaintenance = interaction.options.getString("상태") === "on";
    setConfig("maintenance", String(_isMaintenance));
    await updateStockMessage();
    await interaction.reply({ components: [uiMaintenanceToggle(_isMaintenance)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  if (commandName === "정보조회") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const row = getVerifiedInfo(targetId);
    if (!row) { await interaction.reply({ content: `❌ <@${targetId}> 는 인증된 유저가 아닙니다.`, ephemeral: true }); return; }
    const spent = getTotalSpent(targetId);
    await interaction.reply({
      components: [uiAdminInfo(row, getGrade(spent), getPoints(targetId), spent)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  if (commandName === "재고현황") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const b = await getBalancesKRW();
      await interaction.editReply({ components: [uiStockInfo(b)], flags: MessageFlags.IsComponentsV2 });
    } catch (e) {
      await interaction.editReply({ content: `❌ 조회 실패: ${e.message}` });
    }
    return;
  }

  if (commandName === "수동인증") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const realName = interaction.options.getString("이름");
    const birthday = interaction.options.getString("생년월일");
    const phone    = interaction.options.getString("전화번호");
    const telecom  = interaction.options.getString("통신사");

    addVerifiedNice({ discordId: targetId, realName, birthday, phone, telecom });

    await sendLog(interaction.client, "info", {
      action: "수동 인증 처리",
      user: `<@${targetId}>`,
      name: realName,
      telecom,
      admin: interaction.user.tag,
    });

    await interaction.reply({
      components: [uiManualVerifyDone(targetId, realName)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  if (commandName === "블랙리스트") {
    const action   = interaction.options.getString("동작");   // "추가" | "삭제" | "조회"
    const targetId = extractUserId(interaction.options.getString("유저"));
    const reason   = interaction.options.getString("사유") || "사유 없음";

    if (action === "추가") {
      addBlacklist(targetId, reason, interaction.user.tag);
      await sendLog(interaction.client, "info", { action: "블랙리스트 추가", user: `<@${targetId}>`, reason, admin: interaction.user.tag });
      await interaction.reply({ components: [uiBlacklistUpdated("추가", targetId, reason)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else if (action === "삭제") {
      const removed = removeBlacklist(targetId);
      if (removed) {
        await sendLog(interaction.client, "info", { action: "블랙리스트 해제", user: `<@${targetId}>`, admin: interaction.user.tag });
      }
      await interaction.reply({ components: [uiBlacklistUpdated(removed ? "삭제" : "없음", targetId, reason)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else if (action === "조회") {
      const entry = getBlacklistEntry(targetId);
      await interaction.reply({ components: [uiBlacklistInfo(`<@${targetId}>`, entry)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "❌ 동작 값이 올바르지 않습니다. (추가/삭제/조회 중 하나여야 합니다)", ephemeral: true });
    }
    return;
  }

  if (commandName === "잔액조정") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const amount   = interaction.options.getInteger("금액");

    if (!amount || amount === 0) {
      await interaction.reply({ content: "❌ 유효하지 않은 금액입니다.", ephemeral: true });
      return;
    }

    addPoints(targetId, amount);
    const newBalance = getPoints(targetId);

    await sendLog(interaction.client, "info", {
      action: "잔액 조정",
      user: `<@${targetId}>`,
      amount: amount.toLocaleString(),
      balance: newBalance.toLocaleString(),
      admin: interaction.user.tag,
    });

    await interaction.reply({
      components: [uiManualChargeDone(targetId, amount, newBalance)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    try {
      const user = await interaction.client.users.fetch(targetId);
      await user.send({ components: [uiBalanceAdjustedDM(amount, newBalance)], flags: MessageFlags.IsComponentsV2 });
    } catch { /* DM 차단 */ }
    return;
  }

  if (commandName === "누적송금조정") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const amount   = interaction.options.getInteger("금액");

    if (!amount || amount === 0) {
      await interaction.reply({ content: "❌ 유효하지 않은 금액입니다. (0이 아닌 값, 음수 가능)", ephemeral: true });
      return;
    }

    adjustTotalSpent(targetId, amount);
    const newTotal = getTotalSpent(targetId);

    await sendLog(interaction.client, "info", {
      action: "누적송금 조정",
      user: `<@${targetId}>`,
      조정액: amount.toLocaleString(),
      새누적: newTotal.toLocaleString(),
      admin: interaction.user.tag,
    });

    // 조정으로 인해 새 등급을 달성했을 수도 있으므로 체크
    if (interaction.guild) {
      const newGrade = await assignGradeRole(interaction.guild, targetId);
      if (newGrade) {
        try {
          const user = await interaction.client.users.fetch(targetId);
          await user.send({ components: [uiGradeUp(newGrade)], flags: MessageFlags.IsComponentsV2 });
        } catch { /* DM 차단 */ }
      }
    }

    await interaction.reply({
      components: [uiAdjustTotalSpentDone(targetId, amount, newTotal)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  if (commandName === "한도조정") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const limit    = interaction.options.getInteger("한도"); // 생략하면 기본값으로 초기화

    if (limit === null) {
      resetDailyLimitFor(targetId);
      await sendLog(interaction.client, "info", { action: "일일한도 초기화", user: `<@${targetId}>`, admin: interaction.user.tag });
      await interaction.reply({
        components: [uiLimitAdjusted(targetId, DAILY_LIMIT, true)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    if (limit < 0) {
      await interaction.reply({ content: "❌ 한도는 0 이상이어야 합니다.", ephemeral: true });
      return;
    }

    setDailyLimitFor(targetId, limit);
    await sendLog(interaction.client, "info", { action: "일일한도 조정", user: `<@${targetId}>`, 한도: limit.toLocaleString(), admin: interaction.user.tag });
    await interaction.reply({
      components: [uiLimitAdjusted(targetId, limit, false)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

}

/* ============================================================
   버튼
============================================================ */

async function handleButton(interaction) {
  const id = interaction.customId;

  // NICE 인증
  if (id.startsWith("telecom_"))     return handleTelecomButton(interaction);
  if (id.startsWith("start_input_")) return handleStartInputButton(interaction);
  if (id.startsWith("code_input_"))  return handleCodeInputButton(interaction);

  // 내 정보 (+ 송금내역 통합)
  if (id === "user_info_open") {
    const spent = getTotalSpent(interaction.user.id);
    await interaction.reply({
      components: [uiMyInfo({
        user: interaction.user,
        grade: getGrade(spent),
        points: getPoints(interaction.user.id),
        spent,
        dailySpent: getDailySpent(interaction.user.id),
        dailyLimit: getDailyLimitFor(interaction.user.id),
        history: getSendHistory(interaction.user.id, 10),
      })],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  // 등급 안내
  if (id === "grade_info_open") {
    await interaction.reply({ components: [uiGradeInfo()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  // 충전 버튼 → 모달
  if (id === "charge_open") {
    await interaction.showModal(
      new ModalBuilder().setCustomId("charge_modal").setTitle("포인트 충전 신청")
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("charge_amount").setLabel("충전 금액 (원)")
            .setStyle(TextInputStyle.Short).setPlaceholder("예: 10000").setRequired(true)
        ))
    );
    return;
  }

  // 충전 승인
  if (id.startsWith("charge_approve_")) {
    if (!isAdmin(interaction.user.id)) {
      await interaction.reply({ components: [uiNoPermission()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }); return;
    }
    const rest = id.replace("charge_approve_", "");
    const sep  = rest.lastIndexOf("_");
    const userId = rest.slice(0, sep);
    const amount = parseInt(rest.slice(sep + 1));
    addPoints(userId, amount);

    await interaction.update({ components: [uiChargeApproved(userId, amount, interaction.user.tag)], flags: MessageFlags.IsComponentsV2 });

    try {
      const user = await interaction.client.users.fetch(userId);
      await user.send({ components: [uiChargeApprovedDM(amount, getPoints(userId))], flags: MessageFlags.IsComponentsV2 });
    } catch { /* DM 차단 */ }

    if (interaction.guild) {
      const newGrade = await assignGradeRole(interaction.guild, userId);
      if (newGrade) {
        try {
          const user = await interaction.client.users.fetch(userId);
          await user.send({ components: [uiGradeUp(newGrade)], flags: MessageFlags.IsComponentsV2 });
        } catch { /* DM 차단 */ }
      }
    }
    await sendLog(interaction.client, "success", {
      action: "충전 승인",
      user: `<@${userId}>`,
      amount: amount.toLocaleString(),
      admin: interaction.user.tag,
    });
    setTimeout(() => archiveTicketChannel(interaction.channel, userId), 5000);
    return;
  }
  // 충전 거절
  if (id.startsWith("charge_reject_")) {
    if (!isAdmin(interaction.user.id)) {
      await interaction.reply({ components: [uiNoPermission()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }); return;
    }
    const rest = id.replace("charge_reject_", "");
    const sep  = rest.lastIndexOf("_");
    const userId = rest.slice(0, sep);
    const amount = parseInt(rest.slice(sep + 1));

    await interaction.update({ components: [uiChargeRejected(userId, amount, interaction.user.tag)], flags: MessageFlags.IsComponentsV2 });
    try {
      const user = await interaction.client.users.fetch(userId);
      await user.send({ components: [uiChargeRejectedDM(amount)], flags: MessageFlags.IsComponentsV2 });
    } catch { /* DM 차단 */ }
    await sendLog(interaction.client, "fail", {
      action: "충전 거절",
      user: `<@${userId}>`,
      amount: amount.toLocaleString(),
      admin: interaction.user.tag,
    });
    setTimeout(() => archiveTicketChannel(interaction.channel, userId), 5000);
    return;
  }

  // 송금 버튼 → 코인 선택
  if (id === "send_open_select") {
    await interaction.reply({ components: [uiCoinSelect()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  // 계산 버튼 → 코인 선택
  if (id === "calc_open") {
    await interaction.reply({ components: [uiCalcCoinSelect()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  // 송금 취소
  if (id === "send_cancel") {
    pendingTransfers.delete(interaction.user.id);
    await interaction.update({ content: "❌ 송금이 취소되었습니다.", components: [], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  // 송금 확인 → 실제 송금
  if (id === "send_confirm") {
    if (activeSending.has(interaction.user.id)) {
      await interaction.reply({ content: "⏳ 이미 송금이 진행 중입니다.", ephemeral: true }); return;
    }
    await interaction.deferUpdate();

    const pending = pendingTransfers.get(interaction.user.id);
    if (!pending) { await interaction.editReply({ content: "❌ 송금 정보가 만료되었습니다.", components: [] }); return; }
    pendingTransfers.delete(interaction.user.id);
    const { coin, address, coinAmount, krw, actualKrw, feeKrw, userTag } = pending;

    // 포인트 차감
    if (!deductPoints(interaction.user.id, krw)) {
      await interaction.editReply({ components: [uiInsufficientPoints(krw, getPoints(interaction.user.id))], flags: MessageFlags.IsComponentsV2 });
      return;
    }

    activeSending.add(interaction.user.id);

    // 🔧 [핵심 버그 수정] 실제 송금(MEXC 매수+출금) 자체의 성공/실패와,
    // 그 이후의 후속 처리(완료화면 표시/로그/등급체크 등)의 성공/실패를
    // 반드시 분리해야 함. 예전에는 둘 다 같은 try/catch 안에 있어서,
    // 실제 코인이 이미 정상적으로 나간 뒤에 후속 처리 중 아무 에러(디스코드
    // API 일시 오류 등)가 나도 "전체 실패"로 착각해서 포인트를 다시
    // 환불해버리는 심각한 버그가 있었음 (고객은 코인도 받고 포인트도
    // 돌려받는 이중 이득, 운영자 입장에선 "잔액이 안 빠져나간 것처럼" 보임).
    let result;
    try {
      result = await processSwapTransfer("BNB", coin, actualKrw, address);
    } catch (err) {
      // 실제 송금 자체가 실패한 경우에만 환불
      addPoints(interaction.user.id, krw);
      await interaction.editReply({ components: [uiSendFail(err.message)], flags: MessageFlags.IsComponentsV2 });
      await sendLog(interaction.client, "fail", { user: userTag, coin, address, amount: coinAmount.toFixed(6), krw, error: err.message });
      activeSending.delete(interaction.user.id);
      return;
    }

    // 여기부터는 실제 송금이 이미 성공한 상태 → 이후 단계가 실패해도 절대 환불하지 않음
    const actualCoinAmount = result.receivedQty ?? coinAmount; // 실제 매수/출금된 진짜 수량 사용 (추정치 아님)
    try {
      await interaction.editReply({
        components: [uiSendComplete({ coin, coinAmount: actualCoinAmount, krw, address, result })],
        flags: MessageFlags.IsComponentsV2,
      });

      // 로그/기록은 사용자가 모달에 입력한 원래 금액(krw) + 실제 체결된 코인 수량으로 남김
      await sendLog(interaction.client, "success", { user: userTag, coin, address, amount: actualCoinAmount.toFixed(6), krw, hash: result.hash, explorer: result.explorer });
      recordSend(interaction.user.id, { coin, amount: actualCoinAmount, krw, address, hash: result.hash });

      // 공개 채널에 구매 감사 메시지
      await sendPublicPurchaseLog(interaction.client, { userId: interaction.user.id, coin, coinAmount: actualCoinAmount, krw });

      if (interaction.guild) {
        const newGrade = await assignGradeRole(interaction.guild, interaction.user.id);
        if (newGrade) {
          try { await interaction.user.send({ components: [uiGradeUp(newGrade)], flags: MessageFlags.IsComponentsV2 }); }
          catch { /* DM 차단 */ }
        }
      }
      await updateStockMessage();
    } catch (postErr) {
      // 실제 송금은 이미 성공했으므로 환불하지 않고, 관리자에게만 오류를 알림
      console.error("송금 후속 처리 중 오류 (환불하지 않음, 실제 송금은 성공):", postErr.message);
      await sendLog(interaction.client, "fail", {
        user: userTag, coin, address,
        action: "송금 후속 처리 오류 (실제 송금은 성공함, 환불 안 됨)",
        hash: result?.hash ?? "알 수 없음",
        error: postErr.message,
      }).catch(() => {});
    } finally {
      activeSending.delete(interaction.user.id);
    }
  }
}

/* ============================================================
   셀렉트 메뉴
============================================================ */

async function handleSelect(interaction) {
  // 송금 내역 상세
  if (interaction.customId === "info_history_select") {
    const row = db.prepare("SELECT * FROM send_history WHERE id = ?").get(parseInt(interaction.values[0]));
    if (!row) { await interaction.reply({ content: "❌ 내역을 찾을 수 없습니다.", ephemeral: true }); return; }
    await interaction.reply({ components: [uiHistoryDetail(row)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  // 코인 선택 → 네트워크 선택
  if (interaction.customId === "send_select_coin") {
    await interaction.update({ components: [uiNetworkSelect(interaction.values[0])], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  // 네트워크 선택 → 모달
  if (interaction.customId === "send_select_network") {
    const coin = interaction.values[0];
    const placeholder = coin === "TRX" ? "T로 시작하는 주소" : coin === "LTC" ? "L 또는 M으로 시작하는 주소" : coin === "SOL" ? "SOL 지갑 주소" : "0x...";
    await interaction.showModal(
      new ModalBuilder().setCustomId(`send_modal_${coin}`).setTitle(`${coin} 송금`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("send_address").setLabel("받는 주소")
              .setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("send_amount_krw").setLabel("송금 금액 (원화 KRW)")
              .setStyle(TextInputStyle.Short).setPlaceholder("예: 5000").setRequired(true)
          ),
        )
    );
    return;
  }

  // 계산기: 코인 선택 → 금액 입력 모달
  if (interaction.customId === "calc_select_coin") {
    const coin = interaction.values[0];
    await interaction.showModal(
      new ModalBuilder().setCustomId(`calc_modal_${coin}`).setTitle(`${coin} 송금 계산기`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("calc_krw").setLabel("계산할 금액 (원화 KRW)")
            .setStyle(TextInputStyle.Short).setPlaceholder("예: 100000").setRequired(true)
        ))
    );
    return;
  }
}

/* ============================================================
   모달
============================================================ */

async function handleModal(interaction) {
  if (interaction.customId.startsWith("info_modal_")) return handleInfoModal(interaction);
  if (interaction.customId.startsWith("code_modal_")) return handleCodeModal(interaction);

  // 충전 모달
  if (interaction.customId === "charge_modal") {
    await interaction.deferReply({ ephemeral: true });

    // 숫자만 추출 (SQL 인젝션 및 악의적 입력 방지)
    const rawAmount = interaction.fields.getTextInputValue("charge_amount");
    const amount    = parseInt(rawAmount.replace(/[^0-9]/g, ""), 10);

    if (isNaN(amount) || amount <= 0)       { await interaction.editReply({ content: "❌ 유효하지 않은 금액입니다." }); return; }
    if (amount > 10_000_000)                { await interaction.editReply({ content: "❌ 1회 최대 충전액은 10,000,000원입니다." }); return; }

    const row      = getVerifiedInfo(interaction.user.id);
    const username = row?.real_name ?? interaction.user.username;

    // 채널명 특수문자 제거 (Discord 채널명 규칙 + 인젝션 방지)
    const safeUsername = interaction.user.username.replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_\-]/gi, "").slice(0, 20) || "user";

    let ticketChannel;
    try {
      ticketChannel = await interaction.guild.channels.create({
        name: `충전-${safeUsername}`,
        type: ChannelType.GuildText,
        parent: process.env.TICKET_CATEGORY_ID || null,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id,              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ],
      });
    } catch (e) { await interaction.editReply({ content: `❌ 티켓 채널 생성 실패: ${e.message}` }); return; }

    await interaction.editReply({ components: [uiChargeCreated(ticketChannel)], flags: MessageFlags.IsComponentsV2 });
    await ticketChannel.send({ components: [uiChargeTicket(interaction.user.id, username, amount)], flags: MessageFlags.IsComponentsV2 });

    // 티켓 생성 즉시 로그 (신청 유저, 실명, 시각, 금액)
    await sendLog(interaction.client, "info", {
      action: "충전 티켓 생성",
      신청유저: `<@${interaction.user.id}> (${interaction.user.tag})`,
      실명: username,
      신청시각: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
      금액: `${amount.toLocaleString()}원`,
      channel: `<#${ticketChannel.id}>`,
    });
    return;
  }

  // 송금 모달
  if (interaction.customId.startsWith("send_modal_")) {
    await interaction.deferReply({ ephemeral: true });
    const coin    = interaction.customId.replace("send_modal_", "");
    const address = interaction.fields.getTextInputValue("send_address").trim();
    const krw     = parseFloat(interaction.fields.getTextInputValue("send_amount_krw").replace(/,/g, ""));
    const userTag = `${interaction.user.tag} (${interaction.user.id})`;

    if (isNaN(krw) || krw <= 0) { await interaction.editReply({ content: "❌ 유효하지 않은 금액입니다." }); return; }
    if ((coin === "BNB" || coin === "USDTBSC") && !ethers.isAddress(address)) { await interaction.editReply({ content: "❌ 유효하지 않은 BSC 주소입니다." }); return; }
    if (coin === "SOL") {
      try { new (await import("@solana/web3.js")).PublicKey(address); }
      catch { await interaction.editReply({ content: "❌ 유효하지 않은 SOL 주소입니다." }); return; }
    }

    // 포인트 체크
    const balance = getPoints(interaction.user.id);
    if (balance < krw) {
      await interaction.editReply({ components: [uiInsufficientPoints(krw, balance)], flags: MessageFlags.IsComponentsV2 }); return;
    }

    // 일일 한도 체크 (유저별 커스텀 한도가 있으면 그 값을 사용)
    const dailySpent = getDailySpent(interaction.user.id);
    if (!checkDailyLimit(interaction.user.id, krw)) {
      await interaction.editReply({
        components: [uiDailyLimitExceeded(dailySpent, krw, getDailyLimitFor(interaction.user.id))],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    // 수수료 계산 (대행 수수료 5.5% + 현재 김프)
    let rates, coinAmount, feeRate, actualKrw;
    try {
      rates         = await getRates([coin]);
      const kimpRate = Math.max(0, (rates.btcKimp ?? 0) / 100);
      feeRate        = kimpRate + 0.08;
      actualKrw      = Math.floor(krw / (1 + feeRate));
      // actualKrw(KRW) ÷ (KRW/coin) = coin 수량
      coinAmount     = actualKrw / rates[coin];
    } catch { await interaction.editReply({ content: "❌ 환율 조회 실패. 잠시 후 다시 시도해주세요." }); return; }

    if (!coinAmount || !isFinite(coinAmount) || isNaN(coinAmount)) {
      await interaction.editReply({ content: `❌ ${coin} 시세 조회에 실패했습니다. 잠시 후 다시 시도해주세요.` });
      return;
    }

    const feeKrw     = krw - actualKrw;
    const feePercent = (feeRate * 100).toFixed(2);

    pendingTransfers.set(interaction.user.id, { coin, address, coinAmount, krw, actualKrw, feeKrw, userTag });
    await interaction.editReply({
      components: [uiSendConfirm({ coin, address, krw, feeKrw, feePercent, actualKrw, coinAmount, rates })],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  // 계산기 모달: 대행 수수료 5.5% + 현재 김프 반영 + "그대로 받으려면" 역산
  if (interaction.customId.startsWith("calc_modal_")) {
    await interaction.deferReply({ ephemeral: true });
    const coin = interaction.customId.replace("calc_modal_", "");
    const krw  = parseFloat(interaction.fields.getTextInputValue("calc_krw").replace(/,/g, ""));

    if (isNaN(krw) || krw <= 0) { await interaction.editReply({ content: "❌ 유효하지 않은 금액입니다." }); return; }

    let feeRate = 0.08;
    try {
      const rates = await getRates();
      const kimpRate = Math.max(0, (rates.btcKimp ?? 0) / 100);
      feeRate = kimpRate + 0.08;
    } catch (e) {
      console.warn("계산기 김프 조회 실패, 기본 5.5%만 적용:", e.message);
    }

    const feeKrw       = Math.round(krw * feeRate);
    const receivedKrw  = krw - feeKrw;
    // 입력한 금액을 수수료 차감 없이 "그대로" 받으려면 필요한 총 포인트
    const totalNeeded  = Math.ceil(krw / (1 - feeRate));
    const extraNeeded  = totalNeeded - krw;
    const feePercent   = (feeRate * 100).toFixed(2);

    let coinPrice = 0, coinAmount = 0;
    try {
      // 업비트에 상장되지 않은 코인이 많아 바이낸스 시세 + 실시간 환율로 계산
      coinPrice  = await getCalcCoinKrwPrice(coin);
      coinAmount = coinPrice > 0 ? receivedKrw / coinPrice : 0;
    } catch (e) {
      console.error("계산기 시세 조회 실패:", e.message);
    }

    await interaction.editReply({
      components: [uiCalcResult({ coin, krw, feeKrw, feePercent, receivedKrw, coinPrice, coinAmount, totalNeeded, extraNeeded })],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }
}