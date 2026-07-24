import { CHAIN_MAP } from "./ui.js"; // Import 대문자 오타 수정
import WebSocket from 'ws';
import {
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ChannelType, PermissionFlagsBits, MessageFlags,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ButtonBuilder, ButtonStyle,
} from "discord.js";
import { ethers } from "ethers";

import {
  db, isVerified, getVerifiedInfo, addVerifiedNice,
  getPoints, addPoints, deductPoints, getTotalSpent, adjustTotalSpent, getSendHistory,
  getDailySpent, checkDailyLimit, DAILY_LIMIT, getDailyLimitFor, setDailyLimitFor, resetDailyLimitFor,
  getGrade, GRADE_TIERS, getNotifiedGrade, setNotifiedGrade, recordSend, getProfitStats,
  getConfig, setConfig, getAutoChargeLimit, setAutoChargeLimit, getAutoChargeLimitFor, setAutoChargeLimitFor, resetAutoChargeLimitFor,
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
  uiBalanceAdjustedDM, uiChargeLimitExceeded, uiAlreadyPendingCharge,
  uiProfitStatsMenu, uiProfitStats,
} from "./ui.js";

/* ============================================================
   설정 및 상태 관리
============================================================ */
export const pendingTransfers = new Map();
const activeSending = new Set();
let _stockMessage   = null;
let _isMaintenance  = getConfig("maintenance") === "true";

// 💡 자동 충전 대기열 관리 Map
export const pendingAutoCharges = new Map(); 
const PUSHBULLET_TOKEN = process.env.PUSHBULLET_TOKEN || "";
const BANK_INFO = process.env.BANK_INFO || "토스뱅크 1234-5678-9012 홍길동";

/* ============================================================
   블랙리스트
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

/* ============================================================
   유틸리티 함수 모음
============================================================ */
async function archiveTicketChannel(channel, ticketUserId) {
  const archiveCategoryId = process.env.TICKET_ARCHIVE_CATEGORY_ID;
  if (!archiveCategoryId) {
    return channel.delete().catch(() => {});
  }
  try {
    await channel.setParent(archiveCategoryId, { lockPermissions: false });
    if (ticketUserId) {
      await channel.permissionOverwrites.edit(ticketUserId, { SendMessages: false }).catch(() => {});
    }
    if (!channel.name.startsWith("closed-")) {
      await channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => {});
    }
  } catch (e) {
    console.error("티켓 보관 처리 실패:", e.message);
  }
}

const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "").split(",").map(id => id.trim()).filter(Boolean)
);
function isAdmin(userId) { return ADMIN_USER_IDS.has(userId); }

function extractUserId(input) {
  if (!input) return input;
  const match = input.trim().match(/^<@!?(\d+)>$/);
  return match ? match[1] : input.trim();
}

function normalizeSenderName(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

export async function notifyPublicRestock(client, diffKrw) {
  try {
    const channelId = process.env.PUBLIC_STOCK_CHANNEL_ID;
    if (!channelId) return;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    await ch.send({ components: [uiStockRestockAlert(diffKrw)], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {}
}

async function sendPublicPurchaseLog(client, { userId, coin, coinAmount, krw }) {
  try {
    const channelId = process.env.PUBLIC_LOG_CHANNEL_ID;
    if (!channelId) return;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    await ch.send({ components: [uiPurchaseThanks({ userId, coin, coinAmount, krw })], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {}
}

async function assignGradeRole(guild, userId) {
  const grade = getGrade(getTotalSpent(userId));
  if (!grade.roleId) return null;
  if (getNotifiedGrade(userId) >= grade.threshold) return null;

  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    const allTierRoleIds = GRADE_TIERS.map(t => t.roleId);
    const toRemove = allTierRoleIds.filter(id => id !== grade.roleId && member.roles.cache.has(id));
    for (const id of toRemove) await member.roles.remove(id).catch(() => {});
    if (!member.roles.cache.has(grade.roleId)) await member.roles.add(grade.roleId);
    setNotifiedGrade(userId, grade.threshold);
    return grade;
  } catch { return null; }
}

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
    await updateStockMessage();
  } catch (e) {}
}

export async function updateStockMessage() {
  if (!_stockMessage) return;
  try {
    const components = _isMaintenance ? [uiMaintenance()] : await buildMainContainer();
    await _stockMessage.edit({ components, flags: MessageFlags.IsComponentsV2 });
  } catch (e) {}
}

const ALLOW_WITHOUT_VERIFY = ["telecom_SK","telecom_KT","telecom_LG","telecom_MVNO","telecom_SKM","telecom_KTM","telecom_LGM"];
function needsVerifyCheck(interaction) {
  if (interaction.isChatInputCommand() || interaction.isModalSubmit()) return false;
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (ALLOW_WITHOUT_VERIFY.includes(id)) return false;
    if (id.startsWith("start_input_")) return false;
    if (id.startsWith("code_input_")) return false;
    if (id.startsWith("charge_approve_")) return false;
    if (id.startsWith("charge_reject_")) return false;
  }
  return true;
}

/* ============================================================
   인터랙션 메인 핸들러
============================================================ */
export async function handleInteraction(interaction) {
  if (isBlacklisted(interaction.user.id) && !isAdmin(interaction.user.id)) {
    const fn = (interaction.deferred || interaction.replied) ? "followUp" : "reply";
    await interaction[fn]({ components: [uiBlacklisted()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
  if (_isMaintenance && !isAdmin(interaction.user.id)) {
    const fn = (interaction.deferred || interaction.replied) ? "followUp" : "reply";
    await interaction[fn]({ components: [uiMaintenance()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (needsVerifyCheck(interaction) && !isVerified(interaction.user.id)) {
    const fn = (interaction.deferred || interaction.replied) ? "followUp" : "reply";
    await interaction[fn]({ components: [uiVerify()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isButton()) return handleButton(interaction);
  if (interaction.isStringSelectMenu()) return handleSelect(interaction);
  if (interaction.isModalSubmit()) return handleModal(interaction);
}

/* ============================================================
   슬래시 커맨드
============================================================ */
async function handleCommand(interaction) {
  const { commandName } = interaction;
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
    } catch (e) { await interaction.editReply({ content: `❌ 조회 실패: ${e.message}` }); }
    return;
  }
  if (commandName === "수동인증") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const realName = interaction.options.getString("이름");
    const birthday = interaction.options.getString("생년월일");
    const phone    = interaction.options.getString("전화번호");
    const telecom  = interaction.options.getString("통신사");
    addVerifiedNice({ discordId: targetId, realName, birthday, phone, telecom });
    await sendLog(interaction.client, "info", { action: "수동 인증 처리", user: `<@${targetId}>`, name: realName, telecom, admin: interaction.user.tag });
    await interaction.reply({ components: [uiManualVerifyDone(targetId, realName)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (commandName === "블랙리스트") {
    const action   = interaction.options.getString("동작");
    const targetId = extractUserId(interaction.options.getString("유저"));
    const reason   = interaction.options.getString("사유") || "사유 없음";
    if (action === "추가") {
      addBlacklist(targetId, reason, interaction.user.tag);
      await sendLog(interaction.client, "info", { action: "블랙리스트 추가", user: `<@${targetId}>`, reason, admin: interaction.user.tag });
      await interaction.reply({ components: [uiBlacklistUpdated("추가", targetId, reason)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else if (action === "삭제") {
      const removed = removeBlacklist(targetId);
      if (removed) await sendLog(interaction.client, "info", { action: "블랙리스트 해제", user: `<@${targetId}>`, admin: interaction.user.tag });
      await interaction.reply({ components: [uiBlacklistUpdated(removed ? "삭제" : "없음", targetId, reason)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else if (action === "조회") {
      const entry = getBlacklistEntry(targetId);
      await interaction.reply({ components: [uiBlacklistInfo(`<@${targetId}>`, entry)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "❌ 동작 값이 올바르지 않습니다.", ephemeral: true });
    }
    return;
  }
  if (commandName === "잔액조정") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const amount   = interaction.options.getInteger("금액");
    if (!amount || amount === 0) { await interaction.reply({ content: "❌ 유효하지 않은 금액입니다.", ephemeral: true }); return; }
    addPoints(targetId, amount);
    const newBalance = getPoints(targetId);
    await sendLog(interaction.client, "info", { action: "잔액 조정", user: `<@${targetId}>`, amount: amount.toLocaleString(), balance: newBalance.toLocaleString(), admin: interaction.user.tag });
    await interaction.reply({ components: [uiManualChargeDone(targetId, amount, newBalance)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    try { const user = await interaction.client.users.fetch(targetId); await user.send({ components: [uiBalanceAdjustedDM(amount, newBalance)], flags: MessageFlags.IsComponentsV2 }); } catch {}
    return;
  }
  if (commandName === "누적송금조정") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const amount   = interaction.options.getInteger("금액");
    if (!amount || amount === 0) { await interaction.reply({ content: "❌ 유효하지 않은 금액입니다.", ephemeral: true }); return; }
    adjustTotalSpent(targetId, amount);
    const newTotal = getTotalSpent(targetId);
    await sendLog(interaction.client, "info", { action: "누적송금 조정", user: `<@${targetId}>`, 조정액: amount.toLocaleString(), 새누적: newTotal.toLocaleString(), admin: interaction.user.tag });
    if (interaction.guild) {
      const newGrade = await assignGradeRole(interaction.guild, targetId);
      if (newGrade) { try { const user = await interaction.client.users.fetch(targetId); await user.send({ components: [uiGradeUp(newGrade)], flags: MessageFlags.IsComponentsV2 }); } catch {} }
    }
    await interaction.reply({ components: [uiAdjustTotalSpentDone(targetId, amount, newTotal)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (commandName === "한도조정") {
    const targetId = extractUserId(interaction.options.getString("유저"));
    const limit    = interaction.options.getInteger("한도");
    if (limit === null) {
      resetDailyLimitFor(targetId);
      await sendLog(interaction.client, "info", { action: "일일한도 초기화", user: `<@${targetId}>`, admin: interaction.user.tag });
      await interaction.reply({ components: [uiLimitAdjusted(targetId, DAILY_LIMIT, true)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
      return;
    }
    if (limit < 0) { await interaction.reply({ content: "❌ 한도는 0 이상이어야 합니다.", ephemeral: true }); return; }
    setDailyLimitFor(targetId, limit);
    await sendLog(interaction.client, "info", { action: "일일한도 조정", user: `<@${targetId}>`, 한도: limit.toLocaleString(), admin: interaction.user.tag });
    await interaction.reply({ components: [uiLimitAdjusted(targetId, limit, false)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (commandName === "자동충전한도") {
    const target = interaction.options.getUser("유저");
    const amount = interaction.options.getInteger("금액");

    if (!target) {
      // 유저 지정 없으면 전체 기본 한도 변경
      if (amount === null || amount < 0) { await interaction.reply({ content: "❌ 올바른 금액을 입력해주세요.", ephemeral: true }); return; }
      setAutoChargeLimit(amount);
      await sendLog(interaction.client, "info", { action: "자동충전 기본 한도 변경", 한도: amount.toLocaleString(), admin: interaction.user.tag });
      await interaction.reply({ content: `✅ 자동 충전 **기본** 1회 한도가 **${amount.toLocaleString()}원**으로 변경되었습니다.`, ephemeral: true });
    } else {
      // 특정 유저 개별 한도 변경
      if (amount === null) {
        // 금액 생략 시 개별 한도 초기화
        resetAutoChargeLimitFor(target.id);
        await sendLog(interaction.client, "info", { action: "유저 자동충전 한도 초기화", 유저: `<@${target.id}>`, admin: interaction.user.tag });
        await interaction.reply({ content: `✅ <@${target.id}> 님의 자동 충전 한도가 기본값으로 초기화되었습니다.`, ephemeral: true });
      } else {
        if (amount < 0) { await interaction.reply({ content: "❌ 올바른 금액을 입력해주세요.", ephemeral: true }); return; }
        setAutoChargeLimitFor(target.id, amount);
        await sendLog(interaction.client, "info", { action: "유저 자동충전 한도 변경", 유저: `<@${target.id}>`, 한도: amount.toLocaleString(), admin: interaction.user.tag });
        await interaction.reply({ content: `✅ <@${target.id}> 님의 자동 충전 1회 한도가 **${amount.toLocaleString()}원**으로 설정되었습니다.`, ephemeral: true });
      }
    }
    return;
  }
  // 💡 [추가] 수익통계 명령어 핸들러 추가
  if (commandName === "수익통계") {
    await interaction.reply({ components: [uiProfitStatsMenu()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
}

/* ============================================================
   버튼
============================================================ */
async function handleButton(interaction) {
  const id = interaction.customId;

  if (id.startsWith("telecom_"))     return handleTelecomButton(interaction);
  if (id.startsWith("start_input_")) return handleStartInputButton(interaction);
  if (id.startsWith("code_input_"))  return handleCodeInputButton(interaction);

  if (id === "user_info_open") {
    const spent = getTotalSpent(interaction.user.id);
    await interaction.reply({
      components: [uiMyInfo({
        user: interaction.user, grade: getGrade(spent), points: getPoints(interaction.user.id),
        spent, dailySpent: getDailySpent(interaction.user.id), dailyLimit: getDailyLimitFor(interaction.user.id),
        history: getSendHistory(interaction.user.id, 10),
      })],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  if (id === "grade_info_open") {
    await interaction.reply({ components: [uiGradeInfo()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  // 💡 [추가] 수익통계 기간별 버튼 핸들러
  if (id.startsWith("profit_stats_")) {
    const period = id.replace("profit_stats_", ""); // daily, weekly, monthly
    const stats = getProfitStats(period);
    
    const periodLabels = {
      daily: "일간",
      weekly: "주간",
      monthly: "월간"
    };
    
    await interaction.update({ 
      components: [uiProfitStats(periodLabels[period], stats)], 
      flags: MessageFlags.IsComponentsV2 
    });
    return;
  }

  // 💡 자동충전 신청 취소 (대기 화면 / 중복신청 안내 둘 다 여기로 옴)
  if (id.startsWith("auto_charge_cancel_")) {
    const chargeId = id.replace("auto_charge_cancel_", "");
    const entry = pendingAutoCharges.get(chargeId);
    if (!entry || entry.status !== "waiting") {
      await interaction.reply({ content: "❌ 이미 처리되었거나 만료된 신청입니다.", ephemeral: true });
      return;
    }
    clearTimeout(entry.timeoutId);
    pendingAutoCharges.delete(chargeId);
    await interaction.update({ content: "❌ 충전 신청이 취소되었습니다.", ephemeral: true });
    await sendLog(interaction.client, "info", {
      action: "충전 신청 취소",
      유저: `<@${entry.userId}>`,
      입금자명: entry.senderName,
      금액: `${entry.amount.toLocaleString()}원`,
    });
    return;
  }

  // 💡 자동 충전 버튼 모달 연결 (DB에서 입금자명 확인 후 금액만 입력받음)
  if (id === "charge_open") {
    const userInfo = getVerifiedInfo(interaction.user.id);
    if (!userInfo || !userInfo.realName) {
      await interaction.reply({ content: "❌ 실명 인증 정보가 없습니다. 먼저 인증을 진행해주세요.", ephemeral: true });
      return;
    }
    const realName = userInfo.realName;

    await interaction.showModal(
      new ModalBuilder().setCustomId("auto_charge_modal").setTitle("충전신청")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("charge_amount").setLabel("충전 금액 (원)")
              .setStyle(TextInputStyle.Short).setPlaceholder("예: 10000").setRequired(true)
          )
        )
    );
    return;
  }

  if (id === "send_open_select") {
    await interaction.reply({ components: [uiCoinSelect()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (id === "calc_open") {
    await interaction.reply({ components: [uiCalcCoinSelect()], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (id === "send_confirm_no") {
    pendingTransfers.delete(interaction.user.id);
    await interaction.update({ content: "❌ 송금이 취소되었습니다.", components: [], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  if (id === "send_confirm_yes") {
    if (activeSending.has(interaction.user.id)) { await interaction.reply({ content: "⏳ 이미 송금이 진행 중입니다.", ephemeral: true }); return; }
    await interaction.deferUpdate();
    const pending = pendingTransfers.get(interaction.user.id);
    if (!pending) { await interaction.editReply({ content: "❌ 송금 정보가 만료되었습니다.", components: [] }); return; }
    pendingTransfers.delete(interaction.user.id);
    const { coin, address, coinAmount, krw, actualKrw, feeKrw, userTag } = pending;

    if (!deductPoints(interaction.user.id, krw)) { await interaction.editReply({ components: [uiInsufficientPoints(krw, getPoints(interaction.user.id))], flags: MessageFlags.IsComponentsV2 }); return; }
    activeSending.add(interaction.user.id);

    let result;
    try {
      result = await processSwapTransfer("BNB", coin, actualKrw, address);
    } catch (err) {
      addPoints(interaction.user.id, krw);
      await interaction.editReply({ components: [uiSendFail(err.message)], flags: MessageFlags.IsComponentsV2 });
      await sendLog(interaction.client, "fail", { user: userTag, coin, address, amount: coinAmount.toFixed(6), krw, error: err.message });
      activeSending.delete(interaction.user.id);
      return;
    }

    const actualCoinAmount = Number(result.receivedQty ?? coinAmount ?? 0);

        try {
      // ★ 수정된 부분: 누락되었던 feeKrw, actualKrw, hash 등을 모두 전달합니다.
      await interaction.editReply({
        components: [
          uiSendComplete({
            coin,
            coinAmount: actualCoinAmount,
            krw: Number(krw ?? 0),
            feeKrw,       // 추가됨
            actualKrw,    // 추가됨
            address,
            hash: result?.hash, // 추가됨
            result: result ?? {}
          })
        ],
        flags: MessageFlags.IsComponentsV2
      });

      await sendLog(interaction.client, "success", {
        user: userTag,
        coin,
        address,
        amount: actualCoinAmount.toFixed(6),
        krw: Number(krw ?? 0),
        feeKrw,       // 추가됨
        actualKrw,    // 추가됨
        hash: result?.hash,
        explorer: result?.explorer
      });

      await recordSend(interaction.user.id, {
        coin,
        amount: actualCoinAmount,
        krw: Number(krw ?? 0),
        feeKrw,       // 추가됨
        actualKrw,    // 추가됨
        address,
        hash: result?.hash
      });

      await sendPublicPurchaseLog(interaction.client, {
        userId: interaction.user.id,
        coin,
        coinAmount: actualCoinAmount,
        krw: Number(krw ?? 0),
        feeKrw,       // 추가됨
        actualKrw     // 추가됨
      });

      if (interaction.guild) {
        const newGrade = await assignGradeRole(
          interaction.guild,
          interaction.user.id
        );

        if (newGrade) {
          try {
            await interaction.user.send({
              components: [uiGradeUp(newGrade)],
              flags: MessageFlags.IsComponentsV2
            });
          } catch {}
        }
      }

      await updateStockMessage();

    } catch (postErr) {
      console.error("송금 후속 처리 중 오류:", postErr.message);

      await sendLog(interaction.client, "fail", {
        user: userTag,
        coin,
        address,
        action: "송금 후속 처리 오류 (실제 송금은 성공함)",
        hash: result?.hash ?? "알 수 없음",
        error: postErr.message
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
  // 송금 내역 조회
  if (interaction.customId === "history_select") {
    const row = db
      .prepare("SELECT * FROM send_history WHERE id = ?")
      .get(parseInt(interaction.values[0]));

    if (!row) {
      await interaction.reply({
        content: "❌ 내역을 찾을 수 없습니다.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      components: [uiHistoryDetail(row)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  // 송금 - 코인 선택
  if (interaction.customId === "send_select_coin") {
    await interaction.update({
      components: [uiNetworkSelect(interaction.values[0])],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  // 송금 - 네트워크 선택 → 모달 열기
  if (interaction.customId.startsWith("send_select_network_")) {
    const coin = interaction.values[0];

    const placeholder =
      coin === "TRX"
        ? "T로 시작하는 주소"
        : coin === "LTC"
        ? "L 또는 M으로 시작하는 주소"
        : coin === "SOL"
        ? "SOL 지갑 주소"
        : "0x...";

    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`send_modal_${coin}`)
        .setTitle(`${coin} 송금`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("send_address")
              .setLabel("받는 주소")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder(placeholder)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("send_amount_krw")
              .setLabel("송금 금액 (원화 KRW)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("예: 5000")
              .setRequired(true)
          )
        )
    );

    return;
  }

  // 계산기
  if (interaction.customId === "calc_select_coin") {
    const coin = interaction.values[0];

    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`calc_modal_${coin}`)
        .setTitle(`${coin} 송금 계산기`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("calc_krw")
              .setLabel("계산할 금액 (원화 KRW)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("예: 100000")
              .setRequired(true)
          )
        )
    );

    return;
  }
}

/* ============================================================
   모달 (자동 충전 로직 포함)
============================================================ */
async function handleModal(interaction) {
  if (interaction.customId.startsWith("info_modal_")) return handleInfoModal(interaction);
  if (interaction.customId.startsWith("code_modal_")) return handleCodeModal(interaction);

  // 💡 자동 충전 신청 모달 제출 (입금자명 DB 연동)
  if (interaction.customId === "auto_charge_modal") {
    const userInfo = getVerifiedInfo(interaction.user.id);
    if (!userInfo || !userInfo.realName) {
      await interaction.reply({ content: "❌ 실명 인증 정보를 찾을 수 없습니다.", ephemeral: true });
      return;
    }
    const senderName = userInfo.realName;

    const rawAmount = interaction.fields.getTextInputValue("charge_amount");
    const amount = parseInt(rawAmount.replace(/[^0-9]/g, ""), 10);

    if (isNaN(amount) || amount <= 0) { await interaction.reply({ content: "❌ 유효하지 않은 금액입니다.", ephemeral: true }); return; }
    const limit = getAutoChargeLimitFor(interaction.user.id);
    // 💡 1인 1신청 중복 체크
    const existingPending = Array.from(pendingAutoCharges.values()).find(x => x.userId === interaction.user.id && x.status === 'waiting');
    if (existingPending) {
      await interaction.reply({ 
        components: [uiAlreadyPendingCharge(existingPending.id)], 
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral 
      });
      return;
    }

    if (amount > limit) {
      await interaction.reply({ 
        components: [uiChargeLimitExceeded(limit)], 
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral 
      });
      return;
    }

    const id = `${interaction.user.id}_${Date.now()}`;
    const waitingContainer = buildWaitingContainer(senderName, amount, id);

    await interaction.reply({
        components: [waitingContainer],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    const timeoutId = setTimeout(() => {
        if (pendingAutoCharges.has(id) && pendingAutoCharges.get(id).status === 'waiting') {
            pendingAutoCharges.delete(id);
        }
    }, 14 * 60 * 1000); // 14분 대기시간

    pendingAutoCharges.set(id, {
        id,
        userId: interaction.user.id,
        amount,
        senderName,
        status: 'waiting',
        interaction,
        timeoutId
    });
    
    // 디스코드 로그채널 기록
    await sendLog(interaction.client, "info", {
      action: "자동 충전 대기",
      유저: `<@${interaction.user.id}>`,
      입금자명: senderName,
      금액: `${amount.toLocaleString()}원`
    });
    return;
  }

  // 나머지 모달들 (송금, 계산기 등 기존 동일)
  if (interaction.customId.startsWith("send_modal_")) {
  await interaction.deferReply({ ephemeral: true });

  const coin = interaction.customId.replace("send_modal_", "");
  const address = interaction.fields.getTextInputValue("send_address").trim();
  const krw = parseFloat(
    interaction.fields.getTextInputValue("send_amount_krw").replace(/,/g, "")
  );
  const userTag = `${interaction.user.tag} (${interaction.user.id})`;

  if (isNaN(krw) || krw <= 0) {
    await interaction.editReply({ content: "❌ 유효하지 않은 금액입니다." });
    return;
  }

  if ((coin === "BNB" || coin === "USDTBSC") && !ethers.isAddress(address)) {
    await interaction.editReply({ content: "❌ 유효하지 않은 BSC 주소입니다." });
    return;
  }

  if (coin === "SOL") {
    try {
      new (await import("@solana/web3.js")).PublicKey(address);
    } catch {
      await interaction.editReply({ content: "❌ 유효하지 않은 SOL 주소입니다." });
      return;
    }
  }

  const balance = getPoints(interaction.user.id);

  if (balance < krw) {
    await interaction.editReply({
      components: [uiInsufficientPoints(krw, balance)],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  const dailySpent = getDailySpent(interaction.user.id);

  if (!checkDailyLimit(interaction.user.id, krw)) {
    await interaction.editReply({
      components: [
        uiDailyLimitExceeded(
          getDailyLimitFor(interaction.user.id),
          dailySpent,
          krw
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  let rates, coinAmount, feeRate, actualKrw;

  try {
    rates = await getRates([coin]);

    const kimpRate = Math.max(0, (rates.btcKimp ?? 0) / 100);
    feeRate = kimpRate + 0.07;

    actualKrw = Math.floor(krw / (1 + feeRate));
    coinAmount = actualKrw / rates[coin];
  } catch {
    await interaction.editReply({
      content: "❌ 환율 조회 실패. 잠시 후 다시 시도해주세요.",
    });
    return;
  }

  if (!coinAmount || !isFinite(coinAmount) || isNaN(coinAmount)) {
    await interaction.editReply({
      content: `❌ ${coin} 시세 조회에 실패했습니다. 잠시 후 다시 시도해주세요.`,
    });
    return;
  }

  const feeKrw = krw - actualKrw;
  const feePercent = (feeRate * 100).toFixed(2);

  const network = CHAIN_MAP[coin] ?? coin;
  const totalNeeded = krw;

  pendingTransfers.set(interaction.user.id, {
    coin,
    address,
    coinAmount,
    krw,
    actualKrw,
    feeKrw,
    userTag,
  });

  await interaction.editReply({
    components: [
      uiSendConfirm({
        coin,
        network,
        address,
        krw,
        coinAmount,
        feeKrw,
        totalNeeded,
        feePercent,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

  if (interaction.customId.startsWith("calc_modal_")) {
    await interaction.deferReply({ ephemeral: true });
    const coin = interaction.customId.replace("calc_modal_", "");
    const krw  = parseFloat(interaction.fields.getTextInputValue("calc_krw").replace(/,/g, ""));
    if (isNaN(krw) || krw <= 0) { await interaction.editReply({ content: "❌ 유효하지 않은 금액입니다." }); return; }

    let feeRate = 0.055;
    try {
      const rates = await getRates();
      const kimpRate = Math.max(0, (rates.btcKimp ?? 0) / 100);
      feeRate = kimpRate + 0.055;
    } catch (e) { }

    const feeKrw = Math.round(krw * feeRate);
    const receivedKrw = krw - feeKrw;
    const totalNeeded = Math.ceil(krw / (1 - feeRate));
    const extraNeeded = totalNeeded - krw;
    const feePercent = (feeRate * 100).toFixed(2);

    let coinPrice = 0, coinAmount = 0;
    try {
      coinPrice = await getCalcCoinKrwPrice(coin);
      coinAmount = coinPrice > 0 ? receivedKrw / coinPrice : 0;
    } catch (e) {}

    await interaction.editReply({ components: [uiCalcResult({ coin, krw, feeKrw, feePercent, receivedKrw, coinPrice, coinAmount, totalNeeded, extraNeeded })], flags: MessageFlags.IsComponentsV2 });
    return;
  }
}

/* ============================================================
   자동 충전 관련 컨테이너 UI 빌더
============================================================ */
function buildWaitingContainer(senderName, amount, id) {
  const now = new Date();
  const timeStr = `${now.getHours()}시${now.getMinutes()}분`;
  return new ContainerBuilder()
    .setAccentColor(16118000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## <a:Orange_Loading:1524384379806154933> 충전 신청"),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**충전 계좌** \n> **\`하나은행 79191114733007\`**`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**충전 금액**\n> **\`${amount.toLocaleString()}원\`**`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**신청 시각 : \`${timeStr}\`**`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# **입금자명**과 **충전금액**이 **일치**하여야 합니다.`),
    );
}

function buildDoneContainer(senderName, amount, balance) {
  const now = new Date();
  const timeStr = `${now.getHours()}시${now.getMinutes()}분`;
  return new ContainerBuilder()
    .setAccentColor(2403676)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## <a:loading:1523137796389470470> 충전 완료"),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**충전 금액 : \`${amount.toLocaleString()}원\`**\n**현재 잔액 : \`${balance.toLocaleString()}원\`**`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**처리 시각 : \`${timeStr}\`**`),
    );
}

/* ============================================================
   Pushbullet 자동결제 웹소켓 스트림 연동
============================================================ */
export function startPushbulletStream(client) {
  if (!PUSHBULLET_TOKEN) {
      console.warn("⚠️ PUSHBULLET_TOKEN이 설정되지 않아 자동 충전 시스템을 시작할 수 없습니다.");
      return;
  }

  const ws = new WebSocket(`wss://stream.pushbullet.com/websocket/${PUSHBULLET_TOKEN}`);
  
  ws.on('open', () => {
      console.log(`[WS] 자동 충전 시스템 (Pushbullet) 스트림 연결 완료!`);
  });

  ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.type === 'nop' || data.type !== 'push') return; 

      const push = data.push || {};
      if (push.type !== 'mirror') return; 
      handleMirrorPush(push, client);
  });

  ws.on('close', (code, reason) => {
      console.log(`[WS] Pushbullet 연결 끊김. 5초 후 재시도...`);
      setTimeout(() => startPushbulletStream(client), 5000);
  });

  ws.on('error', (err) => {
      console.error(`[WS ERROR] Pushbullet 오류:`, err.message);
  });
}

async function handleMirrorPush(push, client) {
  const title = push.title || "";
  const body = push.body || "";

  // '입금' 키워드가 없으면 무시
  if (!title.includes('입금') && !body.includes('입금')) return;

  // 타이틀과 바디가 어떻게 분리되어 들어올지 모르므로 전체 텍스트로 병합하여 검사
  const fullText = `${title} ${body}`;

  // 금액 추출: "10,000원" 포맷에서 금액 캡처
  const matchedAmount = fullText.match(/([\d,]+)원/)?.[1];
  if (!matchedAmount) return;
  const pushAmount = Number(matchedAmount.replace(/,/g, ""));
  
  // 입금자명 추출 (하나은행 1Q 포맷 반영)
  // 알림 예시: "입금 10,000원 노무현 잔액 3..."
  // "원 " 이후에 오는 첫 번째 공백 없는 단어를 입금자명으로 캡처
  const senderMatch = fullText.match(/원\s+([^\s]+)/);
  if (!senderMatch) return; // 입금자명을 찾을 수 없으면 종료
  const pushSender = senderMatch[1]; 

  const dbList = Array.from(pendingAutoCharges.values());
  const normalizedPushSender = normalizeSenderName(pushSender);
  const target = dbList.find(x =>
    x.amount === pushAmount &&
    normalizeSenderName(x.senderName) === normalizedPushSender &&
    x.status === "waiting"
  );

  if (!target) {
    console.warn("[AUTO_CHARGE] 입금 알림과 대기 건 매칭 실패", {
      pushAmount,
      pushSender,
      normalizedPushSender,
      waiting: dbList
        .filter(x => x.status === "waiting")
        .map(x => ({ amount: x.amount, senderName: x.senderName }))
    });
    return;
  }

  // 매칭 성공 후속 로직 작성 부분...

  // DB 매칭 성공 시 자동 처리 시작
  clearTimeout(target.timeoutId);
  target.status = "done";

  // 포인트 충전
  addPoints(target.userId, target.amount);
  const currentBalance = getPoints(target.userId);

  // 디스코드 메시지 '충전 완료'로 수정
  const doneContainer = buildDoneContainer(target.senderName, target.amount, currentBalance);
  target.interaction.editReply({
      components: [doneContainer],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  }).catch(() => {});

  // 성공 로그 발송
  await sendLog(client, "success", {
      action: "자동 결제 승인",
      유저: `<@${target.userId}>`,
      입금자: target.senderName,
      금액: `${target.amount.toLocaleString()}원`,
      admin: "SYSTEM (Pushbullet)"
  });

  // 역할/등급 업그레이드 여부 확인
  if (target.interaction.guild) {
      const newGrade = await assignGradeRole(target.interaction.guild, target.userId);
      if (newGrade) {
          try { 
              const user = await client.users.fetch(target.userId);
              await user.send({ components: [uiGradeUp(newGrade)], flags: MessageFlags.IsComponentsV2 }); 
          } catch {}
      }
  }

  // 처리 끝난 데이터 메모리 삭제
  pendingAutoCharges.delete(target.id);
}
