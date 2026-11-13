//! Fixture contract.

// crate-level allow, as the fix applies it
#![allow(clippy::too_many_arguments)]

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Contract {}

#[near]
impl Contract {
    pub fn many(&mut self, a: u8, b: u8, c: u8, d: u8, e: u8, f: u8, g: u8) -> u8 {
        a + b + c + d + e + f + g
    }

    // 7 parameters including self: under the limit
    pub fn few(&self, a: u8, b: u8, c: u8, d: u8, e: u8, f: u8) -> u8 {
        a + b + c + d + e + f
    }
}
