// Browser-side daily generation credits shared by every creation page.
// Server-side enforcement should be added to the Edge Functions before launch,
// since browser storage can be cleared or modified by a visitor.
import { supabase } from "./supabaseClient.js";

export const GUEST_DAILY_CREDITS = 30;
export const MEMBER_DAILY_CREDITS = 50;
export const GENERATION_COST = 10;

let creditProfile = {
  storageKey: "ptl_daily_credits",
  allowance: GUEST_DAILY_CREDITS,
  isMember: false,
};

function localDay() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function write(state) {
  try { localStorage.setItem(creditProfile.storageKey, JSON.stringify(state)); } catch { /* keep the in-memory value */ }
  return state;
}

export function configureCreditProfile(user) {
  const isMember = !!user && user.is_anonymous === false;
  creditProfile = isMember
    ? { storageKey: `ptl_daily_credits_${user.id}`, allowance: MEMBER_DAILY_CREDITS, isMember: true }
    : { storageKey: "ptl_daily_credits", allowance: GUEST_DAILY_CREDITS, isMember: false };
  return getDailyCredits();
}

export async function initializeCreditProfile() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return configureCreditProfile(session?.user);
  } catch {
    return configureCreditProfile(null);
  }
}

export function dailyCreditAllowance() {
  return creditProfile.allowance;
}

export function getDailyCredits() {
  const today = localDay();
  try {
    const stored = JSON.parse(localStorage.getItem(creditProfile.storageKey) || "null");
    if (stored?.day === today && Number.isFinite(stored.remaining)) {
      return { day: today, remaining: Math.max(0, Math.min(creditProfile.allowance, stored.remaining)) };
    }
  } catch { /* start a fresh balance */ }
  return write({ day: today, remaining: creditProfile.allowance });
}

export function canAffordGeneration() {
  return getDailyCredits().remaining >= GENERATION_COST;
}

// Call only after a generation has returned successfully.
export function spendGenerationCredits() {
  const balance = getDailyCredits();
  if (balance.remaining < GENERATION_COST) return null;
  return write({ ...balance, remaining: balance.remaining - GENERATION_COST });
}

export function creditBalanceText() {
  const { remaining } = getDailyCredits();
  return `${remaining} credit${remaining === 1 ? "" : "s"} remaining today`;
}
