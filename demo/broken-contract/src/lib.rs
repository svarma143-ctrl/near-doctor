//! Tip jar: send NEAR to an account, and ask what it is owed after the jar's fee.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TipJar {
    tips: LookupMap<AccountId, u128>,
    fee_bps: u32,
    min_tip: u128,
    max_tip: u128,
    label: String,
    paused: bool,
    owner: AccountId,
    note: String,
}

#[near]
impl TipJar {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            tips: LookupMap::new(b"t"),
            fee_bps: 100,
            min_tip: 0,
            max_tip: u128::MAX,
            label: String::new(),
            paused: false,
            owner,
            note: String::new(),
        }
    }

    #[payable]
    pub fn tip(&mut self, to: AccountId) {
        require!(!self.paused, "the jar is paused");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= self.min_tip && amount <= self.max_tip, "tip out of range");
        let current = self.tips.get(&to).copied().unwrap_or(0);
        self.tips.insert(to, current + amount);
    }

    /// What `who` is owed after the jar's fee.
    pub fn amount_owed(&self, who: AccountId) -> U128 {
        U128(amount_owed(self.tips.get(&who).copied().unwrap_or(0), self.fee_bps))
    }

    pub fn configure(
        &mut self,
        fee_bps: u32,
        min_tip: U128,
        max_tip: U128,
        label: String,
        paused: bool,
        owner: AccountId,
        note: String,
    ) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.fee_bps = fee_bps;
        self.min_tip = min_tip.0;
        self.max_tip = max_tip.0;
        self.label = label;
        self.paused = paused;
        self.owner = owner;
        self.note = note;
    }

    pub fn describe(&self) -> String {
        format!("{} ({}) {}", self.label, self.fee_bps, self.note)
    }
}

fn amount_owed(gross: u128, fee_bps: u32) -> u128 {
    gross - gross * fee_bps as u128 / 10_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_is_deducted() {
        assert_eq!(amount_owed(10_000, 100), 9_900);
    }
}
