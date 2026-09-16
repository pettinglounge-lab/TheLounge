// Member balances are authoritative in Supabase; guests retain browser limits.
import { supabase } from "./supabaseClient.js";
export const GUEST_DAILY_CREDITS = 30;
export const MEMBER_DAILY_CREDITS = 50;
export const GENERATION_COST = 10;
let memberId = null;
let memberBalance = null;
let guestMemory = null;
let unavailable = false;
const guestKey = "ptl_daily_credits";
const localDay = () => new Date().toLocaleDateString("en-CA");
function changed() { window.dispatchEvent(new Event("credits-changed")); }
export async function configureCreditProfile(user) {
  memberId = user && user.is_anonymous === false ? user.id : null;
  memberBalance = null;
  return refreshCredits();
}
export async function initializeCreditProfile() {
  const { data, error } = await supabase.auth.getSession();
  if (error) { unavailable = true; changed(); return getDailyCredits(); }
  return configureCreditProfile(data?.session?.user);
}
export function applyCreditBalance(balance) {
  if (!memberId || balance?.user_id !== memberId || !Number.isInteger(balance.free_credits) || !Number.isInteger(balance.purchased_credits)) return;
  memberBalance = { remaining: balance.free_credits + balance.purchased_credits, free: balance.free_credits, purchased: balance.purchased_credits, day: balance.free_credit_date };
  unavailable = false;
  changed();
}
export async function refreshCredits() {
  const id = memberId;
  if (!id) { unavailable = false; changed(); return getDailyCredits(); }
  try {
    const { data, error } = await supabase.rpc("get_member_credit_balance");
    if (id !== memberId) return getDailyCredits();
    if (error || !data) throw error || new Error("Missing balance");
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.user_id !== id) throw new Error("Invalid balance");
    applyCreditBalance(row);
  } catch {
    if (id === memberId) { unavailable = true; memberBalance = null; changed(); }
  }
  return getDailyCredits();
}
export function dailyCreditAllowance() { return memberId ? MEMBER_DAILY_CREDITS : GUEST_DAILY_CREDITS; }
export function getDailyCredits() {
  if (unavailable || (memberId && !memberBalance)) return { remaining: 0, free: 0, purchased: 0, unavailable: true };
  if (memberId) return { ...memberBalance, unavailable: false };
  const day = localDay();
  let stored = guestMemory;
  try { stored = JSON.parse(localStorage.getItem(guestKey)) || stored; } catch {}
  const remaining = stored?.day === day && Number.isFinite(stored.remaining) ? Math.max(0, Math.min(30, stored.remaining)) : 30;
  return { day, remaining, free: remaining, purchased: 0, unavailable: false };
}
export function canAffordGeneration() { return !getDailyCredits().unavailable && getDailyCredits().remaining >= GENERATION_COST; }
export function spendGenerationCredits() {
  if (memberId) return getDailyCredits(); // Never deduct members in the browser.
  const b = getDailyCredits();
  if (b.unavailable || b.remaining < GENERATION_COST) return null;
  guestMemory = { day: b.day, remaining: b.remaining - GENERATION_COST };
  try { localStorage.setItem(guestKey, JSON.stringify(guestMemory)); } catch {}
  changed();
  return getDailyCredits();
}
export function creditBalanceText() {
  const b = getDailyCredits();
  if (b.unavailable) return "Credits unavailable. Please refresh to try again.";
  return memberId ? `${b.free} daily + ${b.purchased} purchased credits` : `${b.remaining} credits remaining today`;
}
export function creditStatusText() { return `${creditBalanceText()} · ${GENERATION_COST} credits per generation`; }
window.addEventListener("focus", () => { void initializeCreditProfile(); });
window.addEventListener("storage", changed);
supabase.auth.onAuthStateChange(() => {
  // Defer database work until Supabase has released its auth callback lock.
  setTimeout(() => { void initializeCreditProfile(); }, 0);
});
